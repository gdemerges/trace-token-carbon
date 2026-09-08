//! Les sources de données, et ce qu'elles produisent.
//!
//! Un collecteur lit ce qui existe déjà sur la machine — journaux de clients,
//! ou API du fournisseur — et rend des événements dans une forme unique. Aucun
//! ne demande de mot de passe, aucun n'envoie quoi que ce soit ailleurs.

pub mod claude_code;

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
