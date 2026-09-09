//! Provenance des chiffres : qui mesure quoi, à quelle granularité, et qui
//! l'emporte quand deux sources décrivent la même consommation.
//!
//! Ce module existe parce que les sources de TRACE ne sont pas commensurables,
//! et que les traiter comme telles produisait deux fautes distinctes :
//!
//!  1. **Le doublon.** `claude-code` lit les journaux locaux, `anthropic-api`
//!     lit la facturation de l'organisation. Ce sont les MÊMES requêtes vues
//!     deux fois : les additionner double le total dès qu'une clé Admin est
//!     renseignée.
//!  2. **L'empilement.** Une source journalière renvoie l'agrégat de la
//!     journée EN COURS, qui grossit d'un relevé à l'autre. Fusionnée comme un
//!     flux d'événements, chaque relevé s'ajoutait au précédent : à une minute
//!     de cadence, la journée courante finissait comptée mille fois.
//!
//! D'où deux notions, portées par une seule table :
//!
//!  - [`Grain`] : ce qu'un événement DÉCRIT. Une requête s'ajoute ; l'état
//!    d'une journée se REMPLACE ; un taux d'occupation ne produit rien.
//!  - `authoritative` : le chiffre vient du fournisseur et non d'une lecture
//!    locale. Il tranche — mais seulement là où il se superpose réellement.
//!
//! La règle de superposition est délibérément conservatrice : la source locale
//! garde la main sur les jours qu'elle couvre, parce qu'elle seule porte le
//! projet, la session et l'heure. La source facturée ne la remplace que là où
//! elle n'a rien vu — une autre machine, un autre poste. L'écart n'est pas
//! masqué pour autant : il devient la table de réconciliation, seule
//! vérification externe que TRACE puisse offrir sur ses propres chiffres.

use crate::collectors::Event;
use crate::util::day_key;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Ce qu'un enregistrement décrit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Grain {
    /// Une requête distincte : elle s'ajoute.
    Request,
    /// L'état complet d'une journée : il remplace le relevé précédent.
    Daily,
    /// Un taux d'occupation instantané : il ne produit pas de tokens.
    Window,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMeta {
    /// Fournisseur logique : deux sources d'une même famille peuvent décrire
    /// la même requête.
    pub family: &'static str,
    pub grain: Grain,
    /// Chiffre communiqué par le fournisseur, par opposition à une lecture
    /// locale.
    pub authoritative: bool,
    pub label: &'static str,
}

/// Métadonnées d'une source inconnue.
///
/// Une source non déclarée est traitée comme un flux de requêtes locales : le
/// comportement historique, et le seul qui ne perde pas de données. Un nouveau
/// collecteur qui oublierait de s'inscrire ici afficherait des chiffres, pas
/// une page blanche.
pub const UNKNOWN: SourceMeta = SourceMeta {
    family: "unknown",
    grain: Grain::Request,
    authoritative: false,
    label: "Source inconnue",
};

pub fn meta(source: &str) -> SourceMeta {
    match source {
        "claude-code" => SourceMeta {
            family: "anthropic",
            grain: Grain::Request,
            authoritative: false,
            label: "Claude Code",
        },
        "anthropic-oauth" => SourceMeta {
            family: "anthropic",
            grain: Grain::Window,
            authoritative: true,
            label: "Claude en direct",
        },
        "anthropic-api" => SourceMeta {
            family: "anthropic",
            grain: Grain::Daily,
            authoritative: true,
            label: "API Anthropic",
        },
        "codex-cli" => SourceMeta {
            family: "openai",
            grain: Grain::Request,
            authoritative: false,
            label: "Codex CLI",
        },
        "openai-api" => SourceMeta {
            family: "openai",
            grain: Grain::Daily,
            authoritative: true,
            label: "API OpenAI",
        },
        _ => UNKNOWN,
    }
}

pub fn is_request_grain(source: &str) -> bool {
    meta(source).grain == Grain::Request
}

pub fn is_daily_grain(source: &str) -> bool {
    meta(source).grain == Grain::Daily
}

/// Clé d'identité d'un agrégat journalier.
///
/// Elle ne contient PAS le volume, et c'est tout l'intérêt : un même
/// (jour, source, modèle, projet) relevé deux fois désigne la même chose quel
/// que soit le total — le second relevé corrige le premier.
pub fn daily_key(e: &Event) -> String {
    format!(
        "{} {} {} {}",
        e.source,
        day_key(e.ts),
        e.model,
        e.project.as_deref().unwrap_or("")
    )
}

/// Fusionne les agrégats journaliers par REMPLACEMENT.
///
/// Tout ce qui porte une clé présente dans `incoming` est évincé de
/// `existing`. Les jours absents du nouveau relevé sont conservés tels quels :
/// un collecteur en erreur renvoie une liste vide et ne doit rien effacer.
pub fn merge_daily(existing: Vec<Event>, incoming: Vec<Event>) -> Vec<Event> {
    if incoming.is_empty() {
        return existing;
    }
    let replaced: HashSet<String> = incoming.iter().map(daily_key).collect();
    let mut kept: Vec<Event> = existing
        .into_iter()
        .filter(|e| !replaced.contains(&daily_key(e)))
        .collect();
    kept.extend(incoming);
    kept
}

/// Les jours où une source locale a vu passer des requêtes, par famille.
pub fn local_coverage(events: &[Event]) -> HashMap<&'static str, HashSet<String>> {
    let mut covered: HashMap<&'static str, HashSet<String>> = HashMap::new();
    for e in events {
        let m = meta(&e.source);
        if m.grain != Grain::Request {
            continue;
        }
        covered.entry(m.family).or_default().insert(day_key(e.ts));
    }
    covered
}

/// Écarte les doublons entre mesure locale et chiffre facturé.
///
/// Rend les événements à agréger, et le nombre d'agrégats facturés écartés
/// parce qu'un relevé local couvrait déjà la même journée.
pub fn dedupe_families(events: &[Event]) -> (Vec<Event>, usize) {
    let covered = local_coverage(events);
    let mut dropped = 0;
    let kept = events
        .iter()
        .filter(|e| {
            let m = meta(&e.source);
            if m.grain != Grain::Daily {
                return true;
            }
            if covered
                .get(m.family)
                .is_some_and(|s| s.contains(&day_key(e.ts)))
            {
                dropped += 1;
                return false;
            }
            true
        })
        .cloned()
        .collect();
    (kept, dropped)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayComparison {
    pub date: String,
    pub local: i64,
    pub billed: i64,
    pub local_requests: i64,
    pub billed_requests: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyReconciliation {
    pub family: String,
    pub days: Vec<DayComparison>,
    pub local: i64,
    pub billed: i64,
    pub delta_pct: Option<f64>,
}

/// Confronte, jour par jour, ce que la machine a mesuré et ce que le
/// fournisseur a facturé.
///
/// C'est la seule vérification externe dont TRACE dispose sur ses propres
/// chiffres : un écart durable de 30 % signale soit une autre machine sur le
/// même compte, soit une erreur d'interprétation des journaux. Les deux
/// méritent d'être vus plutôt que moyennés en silence.
pub fn reconciliation(events: &[Event], from: i64, to: i64) -> Vec<FamilyReconciliation> {
    let mut by_family: HashMap<&'static str, HashMap<String, DayComparison>> = HashMap::new();

    for e in events {
        if e.ts < from || e.ts > to {
            continue;
        }
        let m = meta(&e.source);
        if m.grain == Grain::Window {
            continue;
        }
        let d = day_key(e.ts);
        let day = by_family
            .entry(m.family)
            .or_default()
            .entry(d.clone())
            .or_insert(DayComparison {
                date: d,
                local: 0,
                billed: 0,
                local_requests: 0,
                billed_requests: 0,
            });

        let n = e.tokens.total;
        let requests = if e.requests != 0 { e.requests } else { 1 };
        if m.grain == Grain::Daily {
            day.billed += n;
            day.billed_requests += requests;
        } else {
            day.local += n;
            day.local_requests += requests;
        }
    }

    let mut out: Vec<FamilyReconciliation> = by_family
        .into_iter()
        .filter_map(|(family, days)| {
            // Seuls les jours où les DEUX ont parlé sont comparables. Un jour
            // sans chiffre facturé n'est pas un écart de 100 %, c'est une
            // absence de mesure — les confondre transformerait la table en
            // générateur d'alarmes.
            let mut days: Vec<DayComparison> = days
                .into_values()
                .filter(|d| d.local > 0 && d.billed > 0)
                .collect();
            if days.is_empty() {
                return None;
            }
            days.sort_by(|a, b| a.date.cmp(&b.date));
            let local: i64 = days.iter().map(|d| d.local).sum();
            let billed: i64 = days.iter().map(|d| d.billed).sum();
            Some(FamilyReconciliation {
                family: family.to_string(),
                days,
                local,
                billed,
                delta_pct: if local > 0 {
                    Some(((billed - local) as f64 / local as f64) * 100.0)
                } else {
                    None
                },
            })
        })
        .collect();
    // L'ordre d'une table de hachage n'est pas stable : sans tri, la même
    // donnée produirait deux instantanés différents d'une passe à l'autre.
    out.sort_by(|a, b| a.family.cmp(&b.family));
    out
}
