//! Registre des sources des facteurs d'émission et des constantes de méthode.
//!
//! Raison d'être : un chiffre carbone n'est opposable que si l'on peut
//! remonter chaque facteur à une publication identifiée, dans une version
//! datée. « 56 g par kWh » n'est pas une donnée — « 56 gCO2e/kWh, Base Carbone
//! ADEME v23.4, mix de consommation France, consultée le 12/03/2026 » en est
//! une. Le premier chiffre se discute, le second se vérifie.
//!
//! D'où le champ `pinned` : il vaut faux tant que la version exacte et la date
//! de consultation n'ont pas été relevées SUR la publication. Une source non
//! figée reste utilisable dans l'application — l'ordre de grandeur est bon —
//! mais elle ne peut pas partir dans un livrable audité. [`unpinned_sources`]
//! en donne la liste, et un test la garde visible plutôt que de la laisser
//! s'oublier.
//!
//! Ne jamais inventer un numéro de version pour faire propre : une fausse
//! précision de citation est pire qu'une citation absente, parce qu'elle passe
//! la relecture.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: &'static str,
    /// Titre de la publication.
    pub label: &'static str,
    pub publisher: &'static str,
    pub url: &'static str,
    /// Version ou millésime du jeu de données.
    pub version: Option<&'static str>,
    /// Date de consultation, ISO 8601.
    pub consulted_on: Option<&'static str>,
    /// Version ET date relevées sur la publication.
    pub pinned: bool,
    /// Réserve d'usage, reprise dans le livrable.
    pub note: &'static str,
}

const SOURCES: &[Source] = &[
    Source {
        id: "ecologits",
        label: "Méthodologie d'inférence LLM",
        publisher: "EcoLogits (GenAI Impact)",
        url: "https://ecologits.ai/latest/methodology/llm_inference/",
        version: None,
        consulted_on: None,
        pinned: false,
        note: "L'URL pointe `latest` : elle suit les révisions de la méthode. À remplacer par une URL versionnée avant tout usage en livrable, sans quoi le calcul ne serait pas reproductible.",
    },
    Source {
        id: "boavizta",
        label: "Facteurs d’impact de fabrication des serveurs et GPU",
        publisher: "Boavizta",
        url: "https://boavizta.org/",
        version: None,
        consulted_on: None,
        pinned: false,
        note: "Repris par EcoLogits pour les impacts embarqués. Les valeurs retenues correspondent à un serveur 8 GPU A100 80 Go ; elles n'ont pas été reprises à la source Boavizta elle-même.",
    },
    Source {
        id: "ademe",
        label: "Base Carbone",
        publisher: "ADEME",
        url: "https://base-empreinte.ademe.fr/",
        version: None,
        consulted_on: None,
        pinned: false,
        note: "Mix de CONSOMMATION (et non de production) pour la France : c'est celui qu'attend un bilan d'entreprise, il intègre les imports.",
    },
    Source {
        id: "epaEgrid",
        label: "eGRID — Emissions & Generation Resource Integrated Database",
        publisher: "U.S. Environmental Protection Agency",
        url: "https://www.epa.gov/egrid",
        version: None,
        consulted_on: None,
        pinned: false,
        note: "Moyenne nationale et sous-régions états-uniennes. Facteur de LOCALISATION (location-based) : il ignore les garanties d'origine achetées par les exploitants de centres de données.",
    },
    Source {
        id: "ember",
        label: "Global Electricity Review / Yearly Electricity Data",
        publisher: "Ember",
        url: "https://ember-energy.org/data/yearly-electricity-data/",
        version: None,
        consulted_on: None,
        pinned: false,
        note: "Intensités moyennes mondiales et par zone.",
    },
    Source {
        id: "traceDerived",
        label: "Dérivation interne TRACE (bilan de FLOPs)",
        publisher: "TRACE",
        url: "crates/trace-core/src/carbon/factors.rs",
        version: Some("0.1.0"),
        consulted_on: None,
        pinned: true,
        note: "Estimation d'ingénierie, PAS une mesure. Hors périmètre EcoLogits, assumée comme extension. Le raisonnement complet est en commentaire au point de définition, et les bornes min/max se propagent dans la fourchette.",
    },
    Source {
        id: "providerInfra",
        label: "Rapports environnementaux des exploitants de centres de données",
        publisher: "Amazon Web Services, Google, Microsoft",
        url: "https://sustainability.aboutamazon.com/",
        version: None,
        consulted_on: None,
        pinned: false,
        note: "PUE et WUE annoncés par les exploitants, en moyenne de flotte et non par site. Deux réserves : ce sont des moyennes annuelles mondiales, alors que le site qui sert l'inférence est inconnu ; et ce sont des chiffres déclarés, non audités par un tiers. Les fourchettes retenues couvrent l'écart entre exploitants plutôt que de retenir le meilleur.",
    },
    Source {
        id: "waterFootprint",
        label: "Making AI Less Thirsty — empreinte eau de l’inférence",
        publisher: "Li et al. (UC Riverside / UT Arlington), arXiv:2304.03271",
        url: "https://arxiv.org/abs/2304.03271",
        version: None,
        consulted_on: None,
        pinned: false,
        note: "Distingue l'eau consommée SUR le site (refroidissement) de l'eau consommée HORS site pour produire l'électricité. La seconde domine largement, et dépend du mix électrique — donc de la même hypothèse de localisation que le carbone.",
    },
    Source {
        id: "providerPricing",
        label: "Grilles tarifaires publiques des fournisseurs",
        publisher: "Anthropic, OpenAI",
        url: "https://www.anthropic.com/pricing",
        version: None,
        consulted_on: None,
        pinned: false,
        note: "Factuel, mais volatil : à revérifier à chaque édition du livrable.",
    },
    Source {
        id: "inferredFromBehaviour",
        label: "Estimation TRACE par analogie (aucune publication du fournisseur)",
        publisher: "TRACE",
        url: "crates/trace-core/src/models.rs",
        version: Some("0.1.0"),
        consulted_on: None,
        pinned: true,
        note: "Les fournisseurs de modèles fermés ne publient pas leur nombre de paramètres. Les fourchettes sont larges à dessein et constituent la source d'incertitude DOMINANTE du calcul : c'est le point qu'un vérificateur attaquera en premier, et il doit être présenté comme tel.",
    },
];

/// Résout un identifiant de source.
///
/// Rend `None` plutôt qu'un trou silencieux ; les appelants du crate ne
/// passent que des identifiants littéraux, et un test vérifie qu'ils existent
/// tous.
pub fn source(id: &str) -> Option<&'static Source> {
    SOURCES.iter().find(|s| s.id == id)
}

pub fn all() -> &'static [Source] {
    SOURCES
}

/// Citation lisible, pour une note de bas de page.
pub fn cite(id: &str) -> String {
    let Some(s) = source(id) else {
        return format!("Source inconnue : {id}");
    };
    let mut bits = vec![s.publisher.to_string(), s.label.to_string()];
    if let Some(v) = s.version {
        bits.push(format!("v{v}"));
    }
    if let Some(d) = s.consulted_on {
        bits.push(format!("consultée le {d}"));
    }
    // L'avertissement se déclenche sur `pinned`, pas sur l'absence de date :
    // une dérivation interne est figée par sa version, elle ne se « consulte »
    // pas.
    if !s.pinned {
        bits.push("version et date de consultation NON RELEVÉES".to_string());
    }
    bits.join(", ")
}

/// Les sources qu'il reste à figer avant qu'un livrable soit opposable.
/// Une liste vide est la condition d'entrée dans un rapport audité.
pub fn unpinned_sources() -> Vec<&'static Source> {
    SOURCES.iter().filter(|s| !s.pinned).collect()
}
