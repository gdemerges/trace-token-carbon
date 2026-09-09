//! Registre canonique des modèles.
//!
//! Deux familles d'information cohabitent ici, et elles n'ont PAS le même
//! statut épistémique — l'interface doit les distinguer :
//!
//!  - `pricing` : tarifs publics, en USD par million de tokens. Factuel, mais
//!    volatil, à revérifier à chaque édition d'un livrable audité.
//!  - `params`  : nombre de paramètres (total / actifs), en milliards. Pour
//!    les modèles fermés ces valeurs ne sont PAS divulguées : ce sont des
//!    fourchettes d'estimation, exactement comme le fait EcoLogits pour les
//!    modèles propriétaires. D'où `confidence` et les bornes min/max, qui se
//!    propagent jusqu'à la fourchette carbone affichée.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;

/// Multiplicateurs de cache Anthropic, repris par les autres fournisseurs qui
/// facturent le cache : lecture 0,1x le tarif d'entrée, écriture 1,25x en TTL
/// 5 minutes et 2x en TTL 1 heure.
#[derive(Debug, Clone, Copy)]
pub struct CacheMultipliers {
    pub read: f64,
    pub write5m: f64,
    pub write1h: f64,
}

pub const CACHE_MULTIPLIERS: CacheMultipliers = CacheMultipliers {
    read: 0.1,
    write5m: 1.25,
    write1h: 2.0,
};

/// Fourchette d'estimation. `min == max` signifie une valeur connue avec
/// certitude — et non une estimation qui aurait bien tourné.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Range {
    pub min: f64,
    pub max: f64,
    pub mid: f64,
}

impl Range {
    pub const fn new(min: f64, max: f64) -> Self {
        Self { min, max, mid: (min + max) / 2.0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Confidence {
    /// Valeur publiée par le fournisseur.
    Disclosed,
    /// Fourchette déduite, assumée comme telle.
    Estimated,
    /// Modèle hors registre.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ParamSource {
    InferredFromBehaviour,
    TraceDerived,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamProfile {
    pub total: Range,
    pub active: Range,
    pub confidence: Confidence,
    pub source: ParamSource,
    /// D'où vient la fourchette. Pas « estimation », mais le raisonnement qui
    /// la borne : c'est la première ligne qu'un vérificateur demande à
    /// justifier, puisque c'est la source d'incertitude DOMINANTE du calcul.
    pub basis: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Pricing {
    /// USD par million de tokens d'entrée.
    pub input: f64,
    /// USD par million de tokens de sortie.
    pub output: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub family: String,
    /// `None` quand aucun tarif n'est connu. Distinct d'un tarif nul : voir
    /// [`crate::pricing::cost`], qui refuse de faire passer l'inconnu pour la
    /// gratuité.
    pub pricing: Option<Pricing>,
    pub context: Option<i64>,
    pub params: ParamProfile,
}

// Le raisonnement est le même pour toute la gamme fermée : on l'écrit une
// fois. Les familles qui ont un argument supplémentaire (le tarif, pour les
// extrêmes de gamme) le préfixent.
const BASIS_CLOSED: &str = "Aucune publication du fournisseur. Fourchette bornée par la vitesse de génération observée (50-100 tokens/s), inatteignable en dense à cette échelle, et par le tarif relatif aux modèles de la même famille.";

fn profile(
    total: Range,
    active: Range,
    confidence: Confidence,
    source: ParamSource,
    basis: String,
) -> ParamProfile {
    ParamProfile { total, active, confidence, source, basis }
}

fn closed(total: Range, active: Range, prefix: Option<&str>) -> ParamProfile {
    let basis = match prefix {
        Some(p) => format!("{p} {BASIS_CLOSED}"),
        None => BASIS_CLOSED.to_string(),
    };
    profile(total, active, Confidence::Estimated, ParamSource::InferredFromBehaviour, basis)
}

/// Profils de paramètres par famille.
///
/// Les modèles frontière actuels sont, selon toute vraisemblance, des
/// mixture-of-experts : le nombre de paramètres ACTIFS par token est très
/// inférieur au total. C'est ce qui explique leurs vitesses de génération
/// observées, impossibles à atteindre en dense à cette échelle. Les
/// fourchettes restent larges, à dessein.
pub static PARAM_PROFILES: LazyLock<HashMap<&'static str, ParamProfile>> = LazyLock::new(|| {
    HashMap::from([
        (
            "claude-fable",
            closed(
                Range::new(400.0, 1200.0),
                Range::new(60.0, 250.0),
                Some("Modèle le plus cher de la gamme Anthropic (10/50 USD par Mtok) : borne haute alignée sur ce tarif."),
            ),
        ),
        ("claude-opus", closed(Range::new(300.0, 800.0), Range::new(40.0, 150.0), None)),
        ("claude-sonnet", closed(Range::new(100.0, 300.0), Range::new(15.0, 60.0), None)),
        (
            "claude-haiku",
            closed(
                Range::new(20.0, 80.0),
                Range::new(5.0, 20.0),
                Some("Modèle rapide et bon marché (1/5 USD par Mtok) : la fourchette suit ce positionnement."),
            ),
        ),
        ("gpt-frontier", closed(Range::new(300.0, 1000.0), Range::new(50.0, 200.0), None)),
        ("gpt-mid", closed(Range::new(100.0, 400.0), Range::new(20.0, 80.0), None)),
        ("gpt-small", closed(Range::new(8.0, 50.0), Range::new(3.0, 20.0), None)),
        (
            "unknown",
            profile(
                Range::new(70.0, 400.0),
                Range::new(15.0, 100.0),
                Confidence::Unknown,
                ParamSource::InferredFromBehaviour,
                "Modèle non répertorié : fourchette délibérément très large, couvrant du petit modèle ouvert au modèle frontière. Toute famille représentant une part notable des tokens d'un livrable doit être ajoutée au registre plutôt que laissée ici.".to_string(),
            ),
        ),
    ])
});

pub fn param_profile(family: &str) -> ParamProfile {
    PARAM_PROFILES
        .get(family)
        .or_else(|| PARAM_PROFILES.get("unknown"))
        .expect("le profil `unknown` est toujours présent")
        .clone()
}

struct Entry {
    pattern: &'static str,
    id: &'static str,
    label: &'static str,
    provider: &'static str,
    family: &'static str,
    pricing: Option<Pricing>,
    context: Option<i64>,
}

const fn price(input: f64, output: f64) -> Option<Pricing> {
    Some(Pricing { input, output })
}

/// Le registre. Les motifs sont testés DANS L'ORDRE : les entrées les plus
/// spécifiques doivent précéder les plus générales, sinon `claude-opus-4`
/// avalerait `claude-opus-4-5`.
const REGISTRY: &[Entry] = &[
    // ---- Anthropic ---------------------------------------------------------
    Entry { pattern: r"^claude-mythos-5",  id: "claude-mythos-5",  label: "Claude Mythos 5",  provider: "anthropic", family: "claude-fable",  pricing: price(10.0, 50.0), context: Some(1_000_000) },
    Entry { pattern: r"^claude-fable-5",   id: "claude-fable-5",   label: "Claude Fable 5",   provider: "anthropic", family: "claude-fable",  pricing: price(10.0, 50.0), context: Some(1_000_000) },
    Entry { pattern: r"^claude-opus-5",    id: "claude-opus-5",    label: "Claude Opus 5",    provider: "anthropic", family: "claude-opus",   pricing: price(5.0, 25.0),  context: Some(1_000_000) },
    Entry { pattern: r"^claude-opus-4-8",  id: "claude-opus-4-8",  label: "Claude Opus 4.8",  provider: "anthropic", family: "claude-opus",   pricing: price(5.0, 25.0),  context: Some(1_000_000) },
    Entry { pattern: r"^claude-opus-4-7",  id: "claude-opus-4-7",  label: "Claude Opus 4.7",  provider: "anthropic", family: "claude-opus",   pricing: price(5.0, 25.0),  context: Some(1_000_000) },
    Entry { pattern: r"^claude-opus-4-6",  id: "claude-opus-4-6",  label: "Claude Opus 4.6",  provider: "anthropic", family: "claude-opus",   pricing: price(5.0, 25.0),  context: Some(1_000_000) },
    Entry { pattern: r"^claude-opus-4-5",  id: "claude-opus-4-5",  label: "Claude Opus 4.5",  provider: "anthropic", family: "claude-opus",   pricing: price(5.0, 25.0),  context: Some(200_000) },
    Entry { pattern: r"^claude-opus-4-1",  id: "claude-opus-4-1",  label: "Claude Opus 4.1",  provider: "anthropic", family: "claude-opus",   pricing: price(15.0, 75.0), context: Some(200_000) },
    Entry { pattern: r"^claude-opus-4",    id: "claude-opus-4-0",  label: "Claude Opus 4",    provider: "anthropic", family: "claude-opus",   pricing: price(15.0, 75.0), context: Some(200_000) },
    Entry { pattern: r"^claude-(3-)?opus", id: "claude-3-opus",    label: "Claude Opus 3",    provider: "anthropic", family: "claude-opus",   pricing: price(15.0, 75.0), context: Some(200_000) },
    Entry { pattern: r"^claude-sonnet-5",  id: "claude-sonnet-5",  label: "Claude Sonnet 5",  provider: "anthropic", family: "claude-sonnet", pricing: price(2.0, 10.0),  context: Some(1_000_000) },
    Entry { pattern: r"^claude-sonnet-4-6",id: "claude-sonnet-4-6",label: "Claude Sonnet 4.6",provider: "anthropic", family: "claude-sonnet", pricing: price(3.0, 15.0),  context: Some(1_000_000) },
    Entry { pattern: r"^claude-sonnet-4-5",id: "claude-sonnet-4-5",label: "Claude Sonnet 4.5",provider: "anthropic", family: "claude-sonnet", pricing: price(3.0, 15.0),  context: Some(200_000) },
    Entry { pattern: r"^claude-sonnet-4",  id: "claude-sonnet-4-0",label: "Claude Sonnet 4",  provider: "anthropic", family: "claude-sonnet", pricing: price(3.0, 15.0),  context: Some(200_000) },
    Entry { pattern: r"^claude-3-7-sonnet",id: "claude-3-7-sonnet",label: "Claude Sonnet 3.7",provider: "anthropic", family: "claude-sonnet", pricing: price(3.0, 15.0),  context: Some(200_000) },
    Entry { pattern: r"^claude-3-5-sonnet",id: "claude-3-5-sonnet",label: "Claude Sonnet 3.5",provider: "anthropic", family: "claude-sonnet", pricing: price(3.0, 15.0),  context: Some(200_000) },
    Entry { pattern: r"^claude-haiku-4-5", id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", family: "claude-haiku",  pricing: price(1.0, 5.0),   context: Some(200_000) },
    Entry { pattern: r"^claude-3-5-haiku", id: "claude-3-5-haiku", label: "Claude Haiku 3.5", provider: "anthropic", family: "claude-haiku",  pricing: price(0.8, 4.0),   context: Some(200_000) },
    Entry { pattern: r"^claude-3-haiku",   id: "claude-3-haiku",   label: "Claude Haiku 3",   provider: "anthropic", family: "claude-haiku",  pricing: price(0.25, 1.25), context: Some(200_000) },
    // ---- OpenAI ------------------------------------------------------------
    Entry { pattern: r"^gpt-5.*mini",      id: "gpt-5-mini",       label: "GPT-5 mini",       provider: "openai",    family: "gpt-small",     pricing: price(0.25, 2.0),  context: Some(400_000) },
    Entry { pattern: r"^gpt-5",            id: "gpt-5",            label: "GPT-5",            provider: "openai",    family: "gpt-frontier",  pricing: price(1.25, 10.0), context: Some(400_000) },
    Entry { pattern: r"^o[34]",            id: "o3",               label: "OpenAI o3",        provider: "openai",    family: "gpt-frontier",  pricing: price(2.0, 8.0),   context: Some(200_000) },
    Entry { pattern: r"^gpt-4\.1.*mini",   id: "gpt-4.1-mini",     label: "GPT-4.1 mini",     provider: "openai",    family: "gpt-small",     pricing: price(0.4, 1.6),   context: Some(1_000_000) },
    Entry { pattern: r"^gpt-4\.1",         id: "gpt-4.1",          label: "GPT-4.1",          provider: "openai",    family: "gpt-mid",       pricing: price(2.0, 8.0),   context: Some(1_000_000) },
    Entry { pattern: r"^gpt-4o.*mini",     id: "gpt-4o-mini",      label: "GPT-4o mini",      provider: "openai",    family: "gpt-small",     pricing: price(0.15, 0.6),  context: Some(128_000) },
    Entry { pattern: r"^gpt-4o",           id: "gpt-4o",           label: "GPT-4o",           provider: "openai",    family: "gpt-mid",       pricing: price(2.5, 10.0),  context: Some(128_000) },
    Entry { pattern: r"^codex",            id: "codex",            label: "Codex",            provider: "openai",    family: "gpt-frontier",  pricing: price(1.25, 10.0), context: Some(400_000) },
];

static COMPILED: LazyLock<Vec<(Regex, &'static Entry)>> = LazyLock::new(|| {
    REGISTRY
        .iter()
        .map(|e| {
            let re = Regex::new(e.pattern)
                .unwrap_or_else(|err| panic!("motif de registre invalide `{}` : {err}", e.pattern));
            (re, e)
        })
        .collect()
});

/// Identifiant que Claude Code produit lui-même pour ses messages locaux —
/// erreurs, interruptions. Aucun appel réseau : ni coût, ni empreinte.
const SYNTHETIC: &str = "<synthetic>";

/// Surcharge utilisateur d'une entrée du registre, chargée depuis
/// `models.override.json`. Les tarifs bougent plus vite que les versions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverride {
    pub label: Option<String>,
    pub provider: Option<String>,
    pub family: Option<String>,
    pub pricing: Option<Pricing>,
    pub context: Option<i64>,
}

/// Résout n'importe quelle chaîne de modèle vers un enregistrement canonique.
///
/// Ne rend JAMAIS `None` : un modèle inconnu retombe sur un profil `unknown`
/// explicitement marqué, pour qu'il reste visible dans l'interface plutôt que
/// de disparaître silencieusement des totaux. Un modèle qu'on ne sait pas
/// nommer consomme quand même.
pub fn resolve_model(raw: &str, overrides: Option<&HashMap<String, ModelOverride>>) -> Model {
    let key = if raw.is_empty() {
        "unknown".to_string()
    } else {
        raw.to_lowercase()
    };

    if let Some(ov) = overrides.and_then(|m| m.get(&key)) {
        let family = ov.family.clone().unwrap_or_else(|| "unknown".to_string());
        return Model {
            id: key.clone(),
            label: ov.label.clone().unwrap_or_else(|| key.clone()),
            provider: ov.provider.clone().unwrap_or_else(|| "unknown".to_string()),
            params: param_profile(&family),
            family,
            pricing: ov.pricing,
            context: ov.context,
        };
    }

    if let Some((_, hit)) = COMPILED.iter().find(|(re, _)| re.is_match(&key)) {
        return Model {
            id: hit.id.to_string(),
            label: hit.label.to_string(),
            provider: hit.provider.to_string(),
            family: hit.family.to_string(),
            pricing: hit.pricing,
            context: hit.context,
            params: param_profile(hit.family),
        };
    }

    if key == SYNTHETIC {
        return Model {
            id: key,
            label: "Message local (non facturé)".to_string(),
            provider: "unknown".to_string(),
            family: "unknown".to_string(),
            pricing: price(0.0, 0.0),
            context: None,
            params: profile(
                Range::new(0.0, 0.0),
                Range::new(0.0, 0.0),
                Confidence::Disclosed,
                ParamSource::TraceDerived,
                "Message produit localement par le client, sans appel réseau : empreinte nulle par construction, ce n'est pas une estimation.".to_string(),
            ),
        };
    }

    Model {
        id: key.clone(),
        label: key,
        provider: "unknown".to_string(),
        family: "unknown".to_string(),
        pricing: None,
        context: None,
        params: param_profile("unknown"),
    }
}
