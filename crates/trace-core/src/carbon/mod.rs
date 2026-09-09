//! Estimateur d'empreinte d'inférence LLM.
//!
//! Méthodologie EcoLogits, étendue par TRACE pour prendre en compte les tokens
//! d'entrée et de cache (voir [`factors::TOKEN_ENERGY_WEIGHTS`]).
//!
//! Tout est calculé DEUX fois, sur la borne basse et la borne haute des
//! paramètres estimés et des poids énergétiques : la sortie est une
//! fourchette, jamais un point. C'est le seul parti honnête — les paramètres
//! des modèles fermés ne sont pas publics.

pub mod factors;
pub mod sources;

use crate::models::{Model, ParamProfile, Range};
use crate::util::Tokens;
use factors::{
    grid, pin_range, provider_infra, Ecologits as E, TokenWeights, Water, DEFAULT_GRID_CLOUD,
    GRID_SENSITIVITY, TOKEN_ENERGY_WEIGHTS,
};
use serde::Serialize;

/// Réglages qui écrasent les hypothèses par défaut. Tous facultatifs.
#[derive(Debug, Clone, Default)]
pub struct Options {
    pub grid_key: Option<String>,
    pub grid_intensity: Option<f64>,
    /// Un PUE forcé écrase la fourchette du fournisseur : c'est un choix
    /// explicite, on ne le noie pas dans une plage.
    pub pue: Option<f64>,
    pub weights: Option<TokenWeights>,
    pub params: Option<ParamProfile>,
}

struct Bound {
    energy_wh: f64,
    /// Énergie INFORMATIQUE, hors PUE : c'est à elle que se rapporte le WUE
    /// annoncé par les exploitants, et non à l'énergie au compteur.
    it_energy_wh: f64,
    latency_s: f64,
    gpu_count: f64,
}

/// Énergie et durée d'une génération, pour un jeu d'hypothèses donné.
fn compute_bound(
    t: &Tokens,
    total_params_b: f64,
    active_params_b: f64,
    w: factors::BoundWeights,
    pue: f64,
    gpu_memory_gb: f64,
) -> Bound {
    // Nombre de GPU nécessaires pour héberger les poids quantifiés.
    let required_memory_gb = (total_params_b * E::MODEL_QUANTIZATION_BITS) / 8.0;
    let gpu_count = (required_memory_gb / gpu_memory_gb).ceil().max(1.0);

    // Un « token de sortie équivalent » : chaque classe convertie en son
    // équivalent-décodage par les poids énergétiques.
    let equivalent_output_tokens = t.output as f64 * w.output
        + t.input as f64 * w.input
        + t.cache_write as f64 * w.cache_write
        + t.cache_read as f64 * w.cache_read;

    // Énergie GPU, linéaire en paramètres actifs. Cette corrélation rend DÉJÀ
    // l'énergie de l'ensemble des GPU servant le modèle : ne pas la
    // remultiplier par `gpu_count`. Vérification physique : à 70 Md de
    // paramètres actifs elle donne 7,7 mWh/token, soit ~28 J, ce qui
    // correspond bien à deux A100 à 400 W débitant ~30 tokens/s.
    let gpu_energy_per_token_wh = E::GPU_ENERGY_ALPHA * active_params_b + E::GPU_ENERGY_BETA;
    let gpu_energy_wh = equivalent_output_tokens * gpu_energy_per_token_wh;

    // La latence sert à amortir le reste du serveur et la fabrication.
    let latency_per_token_s = E::GPU_LATENCY_ALPHA * active_params_b + E::GPU_LATENCY_BETA;
    let latency_s = equivalent_output_tokens * latency_per_token_s;

    // Le reste du serveur (CPU, RAM, réseau, alimentation) au prorata des GPU.
    let server_energy_wh =
        (latency_s / 3600.0) * E::SERVER_POWER_W * (gpu_count / E::SERVER_GPU_COUNT);

    // Le PUE couvre le refroidissement et les pertes de distribution.
    let it_energy_wh = gpu_energy_wh + server_energy_wh;
    Bound {
        energy_wh: pue * it_energy_wh,
        it_energy_wh,
        latency_s,
        gpu_count,
    }
}

/// Impact de fabrication du matériel, amorti sur le temps d'occupation.
fn embodied_grams_co2e(latency_s: f64, gpu_count: f64) -> f64 {
    let server_share_kg = E::SERVER_EMBODIED_GWP_KG * (gpu_count / E::SERVER_GPU_COUNT);
    let gpu_share_kg = E::GPU_EMBODIED_GWP_KG * gpu_count;
    (server_share_kg + gpu_share_kg) * (latency_s / E::HARDWARE_LIFESPAN_S) * 1000.0
}

/// Milieu géométrique, arithmétique si une borne est nulle. Plus fidèle que
/// l'arithmétique quand les bornes couvrent un ordre de grandeur.
fn mid(a: f64, b: f64) -> f64 {
    if a > 0.0 && b > 0.0 {
        (a * b).sqrt()
    } else {
        (a + b) / 2.0
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Infra {
    pub key: String,
    pub label: String,
    pub hosts: String,
    pub pue: Range,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    #[serde(rename = "gramsCO2e")]
    pub grams_co2e: Range,
    pub energy_wh: Range,
    pub water_l: Range,
    pub usage_g: f64,
    pub embodied_g: f64,
    pub gpu_count: f64,
    pub grid_intensity: f64,
    pub grid_key: String,
    pub grid_label: String,
    pub confidence: crate::models::Confidence,
    pub infra: Infra,
}

/// Estime l'empreinte d'un volume de tokens sur un modèle donné.
pub fn estimate(tokens: &Tokens, model: &Model, opts: &Options) -> Estimate {
    let infra = provider_infra(&model.provider);

    let pue_low = opts.pue.unwrap_or(infra.pue.min);
    let pue_high = opts.pue.unwrap_or(infra.pue.max);
    let gpu_memory_gb = infra.gpu_memory_gb.unwrap_or(E::GPU_MEMORY_GB);

    let grid_key = opts
        .grid_key
        .clone()
        .unwrap_or_else(|| infra.grid_key.to_string());
    let resolved = grid(&grid_key).or_else(|| grid(DEFAULT_GRID_CLOUD));
    let grid_intensity = opts
        .grid_intensity
        .unwrap_or_else(|| resolved.as_ref().map(|g| g.value).unwrap_or(0.0));
    let grid_label = grid(&grid_key)
        .map(|g| g.label)
        .unwrap_or_else(|| "Personnalisé".to_string());

    let w = opts.weights.unwrap_or(TOKEN_ENERGY_WEIGHTS);
    let p = opts.params.clone().unwrap_or_else(|| model.params.clone());

    let low = compute_bound(
        tokens,
        p.total.min,
        p.active.min,
        w.low(),
        pue_low,
        gpu_memory_gb,
    );
    let high = compute_bound(
        tokens,
        p.total.max,
        p.active.max,
        w.high(),
        pue_high,
        gpu_memory_gb,
    );

    let to_grams = |b: &Bound| {
        (b.energy_wh / 1000.0) * grid_intensity + embodied_grams_co2e(b.latency_s, b.gpu_count)
    };

    // L'eau de refroidissement se rapporte à l'énergie informatique — c'est la
    // définition du WUE — la production d'électricité à l'énergie au compteur.
    let to_water = |b: &Bound, wue: f64, offsite: f64| {
        (b.it_energy_wh / 1000.0) * wue + (b.energy_wh / 1000.0) * offsite
    };

    let g_min = to_grams(&low);
    let g_max = to_grams(&high);
    let e_min = low.energy_wh;
    let e_max = high.energy_wh;
    let w_min = to_water(&low, infra.wue_l.min, Water::OFFSITE_L_PER_KWH.min);
    let w_max = to_water(&high, infra.wue_l.max, Water::OFFSITE_L_PER_KWH.max);

    let mid_latency = (low.latency_s + high.latency_s) / 2.0;
    let mid_gpu = (low.gpu_count + high.gpu_count) / 2.0;
    let mid_energy = mid(e_min, e_max);

    Estimate {
        grams_co2e: Range {
            min: g_min,
            max: g_max,
            mid: mid(g_min, g_max),
        },
        energy_wh: Range {
            min: e_min,
            max: e_max,
            mid: mid_energy,
        },
        water_l: Range {
            min: w_min,
            max: w_max,
            mid: mid(w_min, w_max),
        },
        usage_g: (mid_energy / 1000.0) * grid_intensity,
        embodied_g: embodied_grams_co2e(mid_latency, mid_gpu),
        gpu_count: high.gpu_count,
        grid_intensity,
        grid_key,
        grid_label,
        confidence: p.confidence,
        infra: Infra {
            key: model.provider.clone(),
            label: infra.label.clone(),
            hosts: infra.hosts.to_string(),
            pue: infra.pue,
        },
    }
}

/// Somme d'estimations : les fourchettes s'additionnent bornes à bornes.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Total {
    #[serde(rename = "gramsCO2e")]
    pub grams_co2e: Range,
    pub energy_wh: Range,
    pub water_l: Range,
    pub usage_g: f64,
    pub embodied_g: f64,
}

impl Default for Range {
    fn default() -> Self {
        Range {
            min: 0.0,
            max: 0.0,
            mid: 0.0,
        }
    }
}

pub fn sum<'a, I: IntoIterator<Item = &'a Estimate>>(estimates: I) -> Total {
    let mut acc = Total::default();
    for e in estimates {
        acc.grams_co2e.min += e.grams_co2e.min;
        acc.grams_co2e.max += e.grams_co2e.max;
        acc.grams_co2e.mid += e.grams_co2e.mid;
        acc.energy_wh.min += e.energy_wh.min;
        acc.energy_wh.max += e.energy_wh.max;
        acc.energy_wh.mid += e.energy_wh.mid;
        acc.water_l.min += e.water_l.min;
        acc.water_l.max += e.water_l.max;
        acc.water_l.mid += e.water_l.mid;
        acc.usage_g += e.usage_g;
        acc.embodied_g += e.embodied_g;
    }
    acc
}

/// Un couple volume/modèle, l'unité d'entrée des analyses agrégées.
pub struct Pair<'a> {
    pub tokens: Tokens,
    pub model: &'a Model,
}

fn total_for(pairs: &[Pair], opts: &Options) -> Total {
    let all: Vec<Estimate> = pairs
        .iter()
        .map(|p| estimate(&p.tokens, p.model, opts))
        .collect();
    sum(&all)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRow {
    pub key: String,
    pub label: String,
    pub intensity: f64,
    #[serde(rename = "gramsCO2e")]
    pub grams_co2e: Range,
    pub ratio: Option<f64>,
}

/// Le même total, recalculé sous plusieurs mix électriques.
///
/// C'est l'hypothèse la plus contestable du calcul — on ne sait pas où tourne
/// l'inférence — donc celle qu'un livrable doit exposer plutôt que masquer
/// derrière un total unique. Quatre mix côte à côte disent d'un coup d'œil ce
/// que vaut le chiffre principal.
pub fn grid_sensitivity(pairs: &[Pair], opts: &Options) -> Vec<GridRow> {
    let reference = total_for(pairs, opts).grams_co2e.mid;
    GRID_SENSITIVITY
        .iter()
        .filter_map(|key| {
            let g = grid(key)?;
            let scoped = Options {
                grid_key: Some((*key).to_string()),
                grid_intensity: None,
                ..opts.clone()
            };
            let total = total_for(pairs, &scoped);
            Some(GridRow {
                key: (*key).to_string(),
                label: g.label,
                intensity: g.value,
                ratio: if reference > 0.0 {
                    Some(total.grams_co2e.mid / reference)
                } else {
                    None
                },
                grams_co2e: total.grams_co2e,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lever {
    pub key: &'static str,
    pub label: &'static str,
    pub ratio: f64,
    pub note: &'static str,
}

fn pinned_params(p: &ParamProfile) -> ParamProfile {
    ParamProfile {
        total: pin_range(p.total),
        active: pin_range(p.active),
        ..p.clone()
    }
}

/// D'où vient l'incertitude : contribution de chaque levier, isolément.
///
/// On rejoue le calcul en ne laissant varier QU'UN levier à la fois, tous les
/// autres figés sur leur milieu. Le rapport borne haute / borne basse mesure
/// alors ce que ce levier apporte à lui seul. Sans cette décomposition, une
/// fourchette large se lit comme un aveu d'imprécision générale, alors qu'en
/// pratique un seul terme domine — et c'est celui-là qu'il faut aller
/// corriger, ou défendre devant un vérificateur.
///
/// Ce n'est PAS une propagation d'incertitude au sens statistique : les bornes
/// ne sont pas des intervalles de confiance et les leviers ne se composent pas
/// linéairement. C'est une analyse de sensibilité, et elle se lit comme telle.
pub fn uncertainty(pairs: &[Pair], opts: &Options) -> Vec<Lever> {
    let pinned_weights = TOKEN_ENERGY_WEIGHTS.pinned();
    let all_pinned = |extra: Options| Options {
        weights: Some(pinned_weights),
        ..extra
    };

    // Taille des modèles : seuls les paramètres varient.
    let size = total_for(pairs, &all_pinned(opts.clone())).grams_co2e;

    // Pondération des classes de token : seuls les poids varient.
    let weights = {
        let all: Vec<Estimate> = pairs
            .iter()
            .map(|p| {
                let o = Options {
                    params: Some(pinned_params(&p.model.params)),
                    ..opts.clone()
                };
                estimate(&p.tokens, p.model, &o)
            })
            .collect();
        sum(&all).grams_co2e
    };

    // Infrastructure : seul le PUE varie, entre les bornes du fournisseur.
    let infra_bound = |high: bool| -> f64 {
        let all: Vec<Estimate> = pairs
            .iter()
            .map(|p| {
                let pue = provider_infra(&p.model.provider).pue;
                let o = all_pinned(Options {
                    params: Some(pinned_params(&p.model.params)),
                    pue: Some(if high { pue.max } else { pue.min }),
                    ..opts.clone()
                });
                estimate(&p.tokens, p.model, &o)
            })
            .collect();
        sum(&all).grams_co2e.mid
    };

    // Mix électrique : amplitude sur les mix de l'analyse de sensibilité.
    let grid_mids: Vec<f64> = GRID_SENSITIVITY
        .iter()
        .map(|key| {
            let all: Vec<Estimate> = pairs
                .iter()
                .map(|p| {
                    let o = all_pinned(Options {
                        params: Some(pinned_params(&p.model.params)),
                        grid_key: Some((*key).to_string()),
                        grid_intensity: None,
                        ..opts.clone()
                    });
                    estimate(&p.tokens, p.model, &o)
                })
                .collect();
            sum(&all).grams_co2e.mid
        })
        .collect();

    let spread = |min: f64, max: f64| if min > 0.0 { Some(max / min) } else { None };
    let g_min = grid_mids.iter().cloned().fold(f64::INFINITY, f64::min);
    let g_max = grid_mids.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    let mut levers: Vec<Lever> = [
        ("model", "Taille des modèles", spread(size.min, size.max),
         "Nombre de paramètres totaux et actifs. Aucun fournisseur fermé ne le publie : c'est l'estimation la plus contestable du calcul."),
        ("weights", "Pondération des tokens", spread(weights.min, weights.max),
         "Coût énergétique relatif du prefill et du cache par rapport au décodage. Dérivation interne TRACE, hors périmètre EcoLogits."),
        ("grid", "Mix électrique", spread(g_min, g_max),
         "Amplitude entre la France et la moyenne mondiale. Ce n'est pas une incertitude de mesure mais une hypothèse de localisation."),
        ("infra", "Infrastructure (PUE)", spread(infra_bound(false), infra_bound(true)),
         "Rendement du centre de données, entre les bornes annoncées par les exploitants possibles du fournisseur."),
    ]
    .into_iter()
    .filter_map(|(key, label, ratio, note)| ratio.map(|ratio| Lever { key, label, ratio, note }))
    .collect();

    levers.sort_by(|a, b| b.ratio.total_cmp(&a.ratio));
    levers
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquivalentAmount {
    pub key: &'static str,
    pub label: String,
    pub unit: &'static str,
    pub g_per_unit: f64,
    pub icon: &'static str,
    pub source: &'static str,
    pub note: &'static str,
    pub amount: f64,
}

/// Traduit des grammes de CO2e en équivalents du quotidien.
pub fn equivalents(grams: f64) -> Vec<EquivalentAmount> {
    factors::equivalent_specs()
        .into_iter()
        .map(|e| EquivalentAmount {
            key: e.key,
            label: e.label,
            unit: e.unit,
            g_per_unit: e.g_per_unit,
            icon: e.icon,
            source: e.source,
            note: e.note,
            amount: grams / e.g_per_unit,
        })
        .collect()
}
