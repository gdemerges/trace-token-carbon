//! Les sources de données, et ce qu'elles produisent.
//!
//! Un collecteur lit ce qui existe déjà sur la machine — journaux de clients,
//! ou API du fournisseur — et rend des événements dans une forme unique. Aucun
//! ne demande de mot de passe, aucun n'envoie quoi que ce soit ailleurs.

pub mod claude_code;
pub mod codex_cli;

use crate::util::Tokens;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Un relevé de consommation, l'unité que tout le reste agrège.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Millisecondes depuis l'époque.
    pub ts: i64,
    pub source: String,
    pub model: String,
    pub project: Option<String>,
    pub session: Option<String>,
    pub tokens: Tokens,
    pub requests: i64,
    /// Marque posée par la compaction : un agrégat journalier déjà replié ne
    /// doit pas l'être une seconde fois.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub compacted: Option<String>,
}

/// L'état réel d'une limite de débit, tel que le fournisseur le rapporte.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub source: String,
    pub ts: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: Option<String>,
    pub resets_at: i64,
    pub using_overage: bool,
    /// La CAUSE réelle du refus, qui n'est pas toujours la fenêtre citée.
    pub cause: Cause,
    /// Taux d'occupation communiqué par le fournisseur. Quand il est là, il
    /// tranche : aucune reconstruction locale ne fait mieux que le serveur.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    /// Durée de la fenêtre, telle que le fournisseur la déclare. Codex la
    /// donne, et elle a déjà changé — d'où le libellé dérivé de la durée
    /// plutôt que d'une liste figée.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

impl Quota {
    /// Un relevé de refus, tel que le produit un collecteur de journaux.
    pub fn rejection(source: &str, ts: i64, kind: &str, resets_at: i64, cause: Cause) -> Self {
        Self {
            source: source.to_string(),
            ts,
            kind: kind.to_string(),
            status: None,
            resets_at,
            using_overage: false,
            cause,
            used_percent: None,
            window_minutes: None,
            plan: None,
        }
    }
}

/// Ce qui a réellement bloqué une requête.
///
/// `rateLimitType` vaut toujours « five_hour » : il désigne la fenêtre dont on
/// rapporte l'heure de réinitialisation, PAS ce qui a bloqué. Sur un poste
/// réel, deux refus sur trois viennent d'un plafond de dépense mensuel. Les
/// confondre revient à calibrer la jauge 5 h sur un événement étranger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cause {
    Spend,
    Weekly,
    Window,
    Unknown,
}

/// L'état d'indexation d'un collecteur, persisté entre deux passages.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FileCursor {
    pub offset: u64,
    /// Fenêtre glissante des identifiants déjà vus, bornée : les réécritures
    /// de streaming sont adjacentes dans le fichier, garder tout l'historique
    /// des identifiants ne servirait à rien.
    #[serde(default)]
    pub seen: Vec<String>,
    // Le modèle, le projet et la session n'apparaissent qu'en tête de fichier
    // Codex. En lecture incrémentale on ne les reverra jamais : ils voyagent
    // donc avec l'offset, sans quoi tout ce qui suit une reprise serait
    // attribué à « codex » sans projet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CollectorState {
    #[serde(default)]
    pub files: HashMap<String, FileCursor>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub files: usize,
    pub events: usize,
    pub skipped_duplicates: usize,
}

#[derive(Debug, Default)]
pub struct Collected {
    pub events: Vec<Event>,
    pub quota: Vec<Quota>,
    pub state: CollectorState,
    pub stats: Stats,
}

/// Taille de la fenêtre de déduplication, en identifiants.
pub const DEDUP_WINDOW: usize = 500;

/// Analyse un horodatage ISO 8601, en millisecondes depuis l'époque.
///
/// Rend `None` plutôt qu'une date par défaut : un événement mal daté fausse
/// silencieusement toutes les fenêtres glissantes, alors que l'appelant sait,
/// lui, s'il vaut mieux le rattacher à maintenant ou l'écarter.
pub fn parse_ts(raw: Option<&str>) -> Option<i64> {
    let raw = raw?;
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// Ce qu'une source rapporte d'elle-même à l'interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub id: String,
    pub label: String,
    pub provides_tokens: bool,
    pub enabled: bool,
    pub available: bool,
    /// Nombre d'événements que CE passage a remontés. `snapshot` le remplace
    /// par le total indexé : un collecteur reprend à un offset, et afficher
    /// son delta donnerait « Claude Code — 4 » sur une base de 6 000.
    pub events: usize,
    pub quota: usize,
    pub error: Option<String>,
    pub note: Option<String>,
    pub stats: Stats,
}

/// Résultat d'un passage sur toutes les sources.
#[derive(Debug, Default)]
pub struct CollectedAll {
    pub events: Vec<Event>,
    pub quota: Vec<Quota>,
    pub sources: Vec<SourceStatus>,
    pub state: HashMap<String, CollectorState>,
}

/// Les collecteurs déjà portés, dans l'ordre d'affichage.
const PORTED: &[(&str, &str)] = &[
    (claude_code::SOURCE, "source.claude-code"),
    (codex_cli::SOURCE, "source.codex-cli"),
];

/// Les collecteurs qui restent à porter : ils demandent HTTP et l'accès au
/// trousseau. On les DÉCLARE plutôt que de les faire disparaître — une source
/// absente de la liste se lirait comme une source qui n'existe pas, alors
/// qu'elle existe et ne fonctionne simplement pas encore.
const PENDING: &[(&str, &str, bool)] = &[
    ("anthropic-oauth", "source.anthropic-oauth", false),
    ("anthropic-api", "source.anthropic-api", true),
    ("openai-api", "source.openai-api", true),
];

/// Exécute tous les collecteurs activés et fusionne leurs résultats.
///
/// Chaque collecteur est isolé : celui qui échoue est signalé dans `sources`
/// mais n'empêche jamais les autres de remonter leurs données. Un dossier de
/// journaux corrompu ne doit pas vider tout le tableau de bord.
pub fn collect_all(
    config: &crate::store::Config,
    state: &HashMap<String, CollectorState>,
) -> CollectedAll {
    use crate::i18n::t;

    let disabled: std::collections::HashSet<&str> =
        config.disabled_sources.iter().map(String::as_str).collect();
    let mut out = CollectedAll::default();

    for (id, label_key) in PORTED {
        let mut entry = SourceStatus {
            id: (*id).to_string(),
            label: t(label_key),
            provides_tokens: true,
            enabled: !disabled.contains(id),
            available: false,
            events: 0,
            quota: 0,
            error: None,
            note: None,
            stats: Stats::default(),
        };

        if !entry.enabled {
            entry.note = Some(t("source.disabled"));
            out.sources.push(entry);
            continue;
        }

        let previous = state.get(*id).cloned().unwrap_or_default();
        let collected = if *id == claude_code::SOURCE {
            entry.available = claude_code::is_available(None);
            entry.available.then(|| claude_code::collect(None, &previous))
        } else {
            entry.available = codex_cli::is_available(None);
            entry.available.then(|| codex_cli::collect(None, &previous))
        };

        match collected {
            None => entry.note = Some(t("source.notFound")),
            Some(mut res) => {
                entry.events = res.events.len();
                entry.quota = res.quota.len();
                entry.stats = res.stats;
                out.events.append(&mut res.events);
                out.quota.append(&mut res.quota);
                out.state.insert((*id).to_string(), res.state);
            }
        }
        out.sources.push(entry);
    }

    for (id, label_key, provides_tokens) in PENDING {
        out.sources.push(SourceStatus {
            id: (*id).to_string(),
            label: t(label_key),
            provides_tokens: *provides_tokens,
            enabled: !disabled.contains(id),
            available: false,
            events: 0,
            quota: 0,
            error: None,
            note: Some("Pas encore porté vers Rust".to_string()),
            stats: Stats::default(),
        });
    }

    // Les journaux ne sont pas parcourus dans l'ordre chronologique : la série
    // journalière et les fenêtres glissantes attendent un flux trié.
    out.events.sort_by_key(|e| e.ts);
    out
}
