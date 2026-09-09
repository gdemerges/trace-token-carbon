//! Constantes de la méthodologie EcoLogits / Boavizta pour l'inférence LLM.
//!
//! Référence : <https://ecologits.ai/latest/methodology/llm_inference/>
//!
//! Le modèle physique : l'énergie de génération d'un token est approximée
//! linéairement en fonction du nombre de paramètres ACTIFS du modèle — ce qui
//! rend le calcul valable pour un modèle dense comme pour un mixture-of-experts
//! — le tout mesuré sur un serveur de référence à 8 GPU A100 80 Go.
//!
//! Ne pas retoucher ces valeurs à la légère : ce sont elles qui rendent le
//! chiffre affiché citable. Les paramètres réglables par l'utilisateur (mix
//! électrique, PUE) vivent dans la configuration.

use crate::i18n::t;
use crate::models::Range;
use std::sync::LazyLock;

/// Constantes EcoLogits.
pub struct Ecologits;

impl Ecologits {
    /// Quantification supposée des poids en production (4 bits).
    pub const MODEL_QUANTIZATION_BITS: f64 = 4.0;

    /// Énergie GPU par token généré : `alpha * paramètres_actifs(Md) + beta` [Wh]
    pub const GPU_ENERGY_ALPHA: f64 = 8.91e-5;
    pub const GPU_ENERGY_BETA: f64 = 1.43e-3;

    /// Latence GPU par token généré : `alpha * paramètres_actifs(Md) + beta` [s]
    pub const GPU_LATENCY_ALPHA: f64 = 8.02e-4;
    pub const GPU_LATENCY_BETA: f64 = 2.23e-2;

    /// A100 80 Go de référence.
    pub const GPU_MEMORY_GB: f64 = 80.0;
    pub const SERVER_GPU_COUNT: f64 = 8.0;
    /// Consommation du serveur HORS GPU.
    pub const SERVER_POWER_W: f64 = 1000.0;

    /// Impacts « embarqués » (fabrication), amortis sur la durée de vie.
    pub const GPU_EMBODIED_GWP_KG: f64 = 143.0;
    pub const SERVER_EMBODIED_GWP_KG: f64 = 3000.0;
    /// Cinq ans.
    pub const HARDWARE_LIFESPAN_S: f64 = 5.0 * 365.0 * 24.0 * 3600.0;
}

/// Pondération énergétique par classe de token — extension TRACE, hors
/// périmètre EcoLogits et assumée comme telle.
///
/// EcoLogits ne compte QUE les tokens de sortie. Pour un usage type Claude
/// Code c'est intenable : on observe couramment 300 M de tokens de cache lus
/// pour 500 k tokens générés, et ignorer l'entrée sous-estimerait l'empreinte
/// d'un facteur ~100 sur ce profil.
///
/// Chaque classe est donc convertie en son équivalent-décodage :
///
///  - Sortie = 1,0 par définition. Chaque token impose de relire tous les
///    poids actifs : borné par la bande passante mémoire, donc coûteux.
///  - Entrée (prefill) : même calcul par token, mais traité en un seul batch
///    à forte intensité arithmétique, donc bien mieux amorti.
///  - Lecture de cache : le KV est déjà calculé ; restent la lecture mémoire
///    et l'attention, les projections et le FFN sont économisés.
///  - Écriture de cache : un prefill classique, plus la persistance du KV.
///
/// Calage du ratio prefill sur un bilan de FLOPs plutôt qu'à l'intuition : un
/// prefill de 37 k tokens sur un modèle à 100 Md de paramètres actifs coûte
/// 2 × 100e9 × 37e3 = 7,4e15 FLOPs ; sur 8 A100 à 40 % de MFU cela fait 7,4 s,
/// soit 6,6 Wh à 3,2 kW. Rapporté au token : 1,8e-4 Wh, contre 1,03e-2 Wh pour
/// un token décodé sur le même modèle. Ratio ≈ 0,017. La borne haute couvre
/// les régimes à faible MFU.
///
/// Ce sont des estimations d'ingénierie, pas des mesures, et l'écart min/max
/// se propage jusqu'à la fourchette affichée.
#[derive(Debug, Clone, Copy)]
pub struct TokenWeights {
    pub output: Range,
    pub input: Range,
    pub cache_write: Range,
    pub cache_read: Range,
}

pub const TOKEN_ENERGY_WEIGHTS: TokenWeights = TokenWeights {
    output: Range::new(1.0, 1.0),
    input: Range::new(0.012, 0.06),
    cache_write: Range::new(0.014, 0.07),
    cache_read: Range::new(0.0006, 0.005),
};

/// Un jeu de poids figé sur une seule borne, pour le calcul d'une extrémité.
#[derive(Debug, Clone, Copy)]
pub struct BoundWeights {
    pub output: f64,
    pub input: f64,
    pub cache_write: f64,
    pub cache_read: f64,
}

impl TokenWeights {
    pub fn low(&self) -> BoundWeights {
        BoundWeights {
            output: self.output.min,
            input: self.input.min,
            cache_write: self.cache_write.min,
            cache_read: self.cache_read.min,
        }
    }
    pub fn high(&self) -> BoundWeights {
        BoundWeights {
            output: self.output.max,
            input: self.input.max,
            cache_write: self.cache_write.max,
            cache_read: self.cache_read.max,
        }
    }
    /// Chaque fourchette effondrée sur son milieu géométrique. Sert
    /// exclusivement à l'analyse de sensibilité : mesurer ce qu'un levier
    /// apporte seul suppose de figer tous les autres.
    pub fn pinned(&self) -> Self {
        Self {
            output: pin_range(self.output),
            input: pin_range(self.input),
            cache_write: pin_range(self.cache_write),
            cache_read: pin_range(self.cache_read),
        }
    }
}

/// Effondre une fourchette sur son milieu géométrique — arithmétique si une
/// borne est nulle. Géométrique parce que les bornes couvrent souvent un ordre
/// de grandeur, où la moyenne arithmétique colle à la borne haute.
pub fn pin_range(r: Range) -> Range {
    let v = if r.min > 0.0 && r.max > 0.0 {
        (r.min * r.max).sqrt()
    } else {
        (r.min + r.max) / 2.0
    };
    Range { min: v, max: v, mid: v }
}

/// Infrastructure par fournisseur.
///
/// EcoLogits applique un PUE unique de 1,2 à tout le monde. C'est une moyenne
/// commode, mais elle efface un écart réel : les hyperscalers annoncent 1,09 à
/// 1,20 en moyenne de flotte, quand une colocation ordinaire est plutôt à 1,5.
///
/// Trois réserves, à porter dans tout livrable :
///  1. Ce sont des moyennes annuelles MONDIALES de flotte ; le site précis qui
///     sert une requête n'est pas connu, et un site chaud est bien au-dessus.
///  2. Ce sont des chiffres DÉCLARÉS par les exploitants, non audités.
///  3. Le rattachement d'un fournisseur de modèle à un exploitant de cloud est
///     public dans les grandes lignes, pas la répartition entre eux.
///
/// D'où des FOURCHETTES, jamais un point.
#[derive(Debug, Clone)]
pub struct ProviderInfra {
    pub key: &'static str,
    pub label: String,
    pub hosts: &'static str,
    pub pue: Range,
    /// Eau consommée SUR le site (refroidissement), en litres par kWh
    /// informatique. L'eau hors site dépend du mix et vit dans [`WATER`].
    pub wue_l: Range,
    pub grid_key: &'static str,
    pub gpu_memory_gb: Option<f64>,
    pub source: &'static str,
    pub basis: &'static str,
}

/// L'infrastructure d'un fournisseur, ou la fourchette la plus ouverte quand
/// il est inconnu — jamais l'hypothèse la plus flatteuse.
pub fn provider_infra(provider: &str) -> ProviderInfra {
    match provider {
        "anthropic" => ProviderInfra {
            key: "anthropic",
            label: "Anthropic".to_string(),
            hosts: "Amazon Web Services, Google Cloud",
            pue: Range::new(1.09, 1.2),
            wue_l: Range::new(0.18, 1.1),
            grid_key: "us-average",
            gpu_memory_gb: None,
            source: "providerInfra",
            basis: "Anthropic sert ses modèles depuis AWS (Trainium) et Google Cloud. La fourchette couvre les moyennes de flotte annoncées par ces deux exploitants, sans savoir laquelle sert une requête donnée.",
        },
        "openai" => ProviderInfra {
            key: "openai",
            label: "OpenAI".to_string(),
            hosts: "Microsoft Azure",
            pue: Range::new(1.12, 1.25),
            wue_l: Range::new(0.3, 0.5),
            grid_key: "us-average",
            gpu_memory_gb: None,
            source: "providerInfra",
            basis: "OpenAI sert ses modèles depuis Azure. La fourchette couvre la moyenne de flotte annoncée par Microsoft et la dispersion entre régions, la région servant une requête donnée n'étant pas connue.",
        },
        "local" => ProviderInfra {
            key: "local",
            label: t("infra.local"),
            hosts: "poste de l'utilisateur",
            pue: Range::new(1.0, 1.1),
            wue_l: Range::new(0.0, 0.0),
            grid_key: "france",
            gpu_memory_gb: Some(24.0),
            source: "traceDerived",
            basis: "Pas de centre de données : ni refroidissement mécanique dédié (PUE ~ 1) ni consommation d'eau. Un seul GPU grand public de 24 Go, et le mix électrique du domicile et non celui du fournisseur.",
        },
        _ => ProviderInfra {
            key: "unknown",
            label: t("infra.unknown"),
            hosts: "inconnu",
            pue: Range::new(1.2, 1.6),
            wue_l: Range::new(0.2, 1.8),
            grid_key: "world",
            gpu_memory_gb: None,
            source: "providerInfra",
            basis: "Aucun rattachement connu : la fourchette s'ouvre du meilleur hyperscaler à un centre de données de colocation ordinaire (PUE ~ 1,5), et le mix électrique retenu est la moyenne mondiale plutôt qu'une hypothèse de localisation flatteuse.",
        },
    }
}

/// Empreinte eau hors site : celle qu'il a fallu pour produire l'électricité.
///
/// Elle domine généralement l'eau de refroidissement et dépend du mix — un
/// réseau nucléaire ou thermique en consomme beaucoup, un réseau éolien
/// presque rien. Faute d'un facteur par pays, une fourchette couvrant les mix
/// courants : grossier, mais honnête tant qu'elle est affichée comme telle.
pub struct Water;
impl Water {
    pub const OFFSITE_L_PER_KWH: Range = Range::new(1.2, 3.1);
}

/// Intensité carbone du réseau, en gCO2eq/kWh.
///
/// Toutes ces valeurs sont des facteurs de LOCALISATION au sens du GHG
/// Protocol : l'intensité physique du réseau qui alimente le site. Elles
/// ignorent délibérément les garanties d'origine et PPA achetés par les
/// exploitants, qui feraient s'effondrer le chiffre en approche market-based.
/// Un bilan complet déclare les deux ; TRACE ne peut calculer que le premier,
/// faute de publication — et c'est aussi le plus conservateur, donc le
/// défendable.
#[derive(Debug, Clone)]
pub struct Grid {
    pub key: &'static str,
    pub label: String,
    pub value: f64,
    pub source: &'static str,
    pub basis: &'static str,
}

const GRID_TABLE: &[(&str, f64, &str)] = &[
    ("france", 56.0, "ademe"),
    ("sweden", 40.0, "ember"),
    ("canada", 120.0, "ember"),
    ("uk", 210.0, "ember"),
    ("eu-27", 250.0, "ember"),
    ("us-west", 240.0, "epaEgrid"),
    ("us-east", 320.0, "epaEgrid"),
    ("us-average", 369.0, "epaEgrid"),
    ("germany", 380.0, "ember"),
    ("world", 480.0, "ember"),
    ("asia", 540.0, "ember"),
];

pub fn grid(key: &str) -> Option<Grid> {
    GRID_TABLE.iter().find(|(k, _, _)| *k == key).map(|(k, v, s)| Grid {
        key: k,
        label: t(&format!("grid.{k}")),
        value: *v,
        source: s,
        basis: "location-based",
    })
}

pub fn grid_keys() -> Vec<&'static str> {
    GRID_TABLE.iter().map(|(k, _, _)| *k).collect()
}

/// Filet de sécurité si un fournisseur n'a pas d'infrastructure connue. En
/// régime normal c'est [`provider_infra`] qui décide de la localisation.
pub const DEFAULT_GRID_CLOUD: &str = "us-average";

/// Les bornes de l'analyse de sensibilité au mix électrique.
///
/// C'est l'hypothèse la plus contestable du calcul — on ne sait pas où tourne
/// l'inférence — et le rapport entre le mix français et le mix asiatique est
/// de près de dix. Tout livrable doit porter cette analyse plutôt qu'un total
/// unique.
pub const GRID_SENSITIVITY: [&str; 4] = ["france", "eu-27", "us-average", "world"];

/// Équivalents parlants, en gCO2eq par unité.
///
/// Chacun porte sa réserve : un équivalent donne une intuition, pas une
/// comparaison rigoureuse. Le périmètre de chaque facteur — usage seul ou
/// cycle de vie, France ou monde — diffère de celui du calcul carbone, et le
/// dire à la ligne évite qu'un lecteur les additionne.
#[derive(Debug, Clone)]
pub struct Equivalent {
    pub key: &'static str,
    pub label: String,
    pub unit: &'static str,
    pub g_per_unit: f64,
    pub icon: &'static str,
    pub source: &'static str,
    pub note: &'static str,
}

pub static EQUIVALENT_TABLE: LazyLock<Vec<(&'static str, &'static str, f64, &'static str, &'static str)>> =
    LazyLock::new(|| {
        vec![
            ("car", "km", 120.0, "🚗", "Voiture particulière moyenne, usage seul (hors fabrication du véhicule)."),
            ("streaming", "h", 36.0, "📺", "Ordre de grandeur très dépendant du terminal, de la définition et du réseau."),
            ("phone", "", 8.0, "🔋", "Une charge complète sur le mix français, hors fabrication de l’appareil."),
            ("tgv", "km", 2.3, "🚆", "Par voyageur-kilomètre, sur le mix électrique français."),
            ("beef", "g", 27.0, "🥩", "Viande bovine, du champ à l’assiette. Périmètre cycle de vie, contrairement aux autres équivalents."),
        ]
    });

pub fn equivalent_specs() -> Vec<Equivalent> {
    EQUIVALENT_TABLE
        .iter()
        .map(|(key, unit, g, icon, note)| Equivalent {
            key,
            label: t(&format!("equiv.{key}")),
            unit,
            g_per_unit: *g,
            icon,
            source: "ademe",
            note,
        })
        .collect()
}

/// Une ligne de l'annexe méthodologique.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactorRow {
    pub group: &'static str,
    pub key: String,
    pub value: String,
    pub unit: &'static str,
    pub source: &'static str,
    pub citation: String,
    /// Version et date relevées sur la publication : condition d'entrée dans
    /// un livrable audité.
    pub pinned: bool,
    pub note: String,
}

fn row(group: &'static str, key: String, value: String, unit: &'static str, source_id: &'static str, note: &str) -> FactorRow {
    let s = super::sources::source(source_id);
    FactorRow {
        group,
        key,
        value,
        unit,
        source: source_id,
        citation: super::sources::cite(source_id),
        pinned: s.is_some_and(|s| s.pinned),
        note: if note.is_empty() { s.map(|s| s.note.to_string()).unwrap_or_default() } else { note.to_string() },
    }
}

const G_METHOD: &str = "Méthode d’inférence";
const G_WEIGHTS: &str = "Pondération par classe de token";
const G_GRID: &str = "Mix électrique";
const G_INFRA: &str = "Infrastructure du fournisseur";
const G_WATER: &str = "Empreinte eau";
const G_EQUIV: &str = "Équivalent de communication";

/// Tableau des facteurs employés, prêt à être annexé à un rapport : une ligne
/// par constante, avec sa valeur, son unité et sa citation.
///
/// La méthodologie voyage AVEC le chiffre. La construire et ne jamais la
/// montrer reviendrait à demander de croire un total dont aucun terme n'est
/// vérifiable — exactement ce qu'un chiffre carbone ne doit pas être.
///
/// `grid_key` restreint la citation au seul mix effectivement retenu : citer
/// les onze quand le calcul n'en emploie qu'un est la faute qu'un vérificateur
/// relève en premier.
pub fn factor_table(grid_key: Option<&str>) -> Vec<FactorRow> {
    let mut rows = Vec::new();

    let m = |k: &str, v: String, u: &'static str, note: &str| (k.to_string(), v, u, note.to_string());
    for (key, value, unit, note) in [
        m("MODEL_QUANTIZATION_BITS", Ecologits::MODEL_QUANTIZATION_BITS.to_string(), "bits",
          "Hypothèse de service en production. Aucun fournisseur fermé ne publie sa quantification ; elle ne joue que sur le nombre de GPU nécessaires, donc sur la part serveur et la fabrication."),
        m("GPU_ENERGY_ALPHA", Ecologits::GPU_ENERGY_ALPHA.to_string(), "Wh/token/Md-paramètres",
          "Régression EcoLogits sur modèles ouverts, extrapolée aux modèles fermés."),
        m("GPU_ENERGY_BETA", Ecologits::GPU_ENERGY_BETA.to_string(), "Wh/token", ""),
        m("GPU_LATENCY_ALPHA", Ecologits::GPU_LATENCY_ALPHA.to_string(), "s/token/Md-paramètres", ""),
        m("GPU_LATENCY_BETA", Ecologits::GPU_LATENCY_BETA.to_string(), "s/token", ""),
        m("GPU_MEMORY_GB", Ecologits::GPU_MEMORY_GB.to_string(), "Go",
          "Serveur de référence A100 80 Go. Le matériel réellement employé par les fournisseurs est plus récent (H100/H200, TPU) et vraisemblablement plus efficace : le calcul est donc plutôt conservateur."),
        m("SERVER_GPU_COUNT", Ecologits::SERVER_GPU_COUNT.to_string(), "GPU", ""),
        m("SERVER_POWER_W", Ecologits::SERVER_POWER_W.to_string(), "W", "Hors GPU."),
    ] {
        rows.push(row(G_METHOD, key, value, unit, "ecologits", &note));
    }
    for (key, value, unit, note) in [
        m("GPU_EMBODIED_GWP_KG", Ecologits::GPU_EMBODIED_GWP_KG.to_string(), "kgCO2e/GPU", ""),
        m("SERVER_EMBODIED_GWP_KG", Ecologits::SERVER_EMBODIED_GWP_KG.to_string(), "kgCO2e/serveur", "Hors GPU."),
        m("HARDWARE_LIFESPAN_S", Ecologits::HARDWARE_LIFESPAN_S.to_string(), "s",
          "Amortissement sur 5 ans. Une durée de vie réelle plus courte en centre de données majorerait la part de fabrication."),
    ] {
        rows.push(row(G_METHOD, key, value, unit, "boavizta", &note));
    }

    let w = TOKEN_ENERGY_WEIGHTS;
    for (key, r, note) in [
        ("output", w.output, "Référence, 1.0 par définition."),
        ("input", w.input, "Bilan de FLOPs du prefill, MFU 40 % (borne basse) à MFU faible (borne haute)."),
        ("cacheWrite", w.cache_write, "Prefill + persistance du KV."),
        ("cacheRead", w.cache_read, "Lecture mémoire et attention seules ; projections et FFN économisés."),
    ] {
        rows.push(row(G_WEIGHTS, key.to_string(), format!("{} – {}", r.min, r.max),
                      "équivalent-token de sortie", "traceDerived", note));
    }

    // Le mix retenu, et lui seul, quand l'appelant le précise.
    let keys: Vec<&str> = match grid_key {
        Some(k) => vec![k],
        None => grid_keys(),
    };
    for k in keys {
        let Some(g) = grid(k) else { continue };
        rows.push(row(G_GRID, g.label.clone(), g.value.to_string(), "gCO2e/kWh", g.source,
                      &format!("Approche {}.", g.basis)));
    }

    for key in ["anthropic", "openai", "local", "unknown"] {
        let i = provider_infra(key);
        rows.push(row(G_INFRA, format!("{} — PUE", i.label), format!("{} – {}", i.pue.min, i.pue.max),
                      "sans dimension", i.source, i.basis));
        rows.push(row(G_INFRA, format!("{} — eau sur site", i.label), format!("{} – {}", i.wue_l.min, i.wue_l.max),
                      "L/kWh", if i.wue_l.max > 0.0 { "waterFootprint" } else { i.source },
                      &format!("Hébergement : {}.", i.hosts)));
        if grid_key.is_some() {
            continue; // le mix retenu est déjà cité plus haut
        }
        let label = grid(i.grid_key).map(|g| g.label).unwrap_or_else(|| i.grid_key.to_string());
        rows.push(row(G_INFRA, format!("{} — mix par défaut", i.label), label, "zone", i.source,
                      &format!("Hypothèse de localisation pour {key}.")));
    }

    rows.push(row(G_WATER, "OFFSITE_L_PER_KWH".to_string(),
                  format!("{} – {}", Water::OFFSITE_L_PER_KWH.min, Water::OFFSITE_L_PER_KWH.max),
                  "L/kWh", "waterFootprint",
                  "Eau consommée pour produire l'électricité, hors site. Fourchette couvrant les mix électriques courants, faute d'un facteur par pays."));

    for e in equivalent_specs() {
        rows.push(row(G_EQUIV, e.label, e.g_per_unit.to_string(), "gCO2e/unité", e.source, e.note));
    }

    rows
}
