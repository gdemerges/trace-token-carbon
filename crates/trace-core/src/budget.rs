//! Le budget mensuel : combien a-t-on dépensé ce mois-ci, et où cela mène.
//!
//! Même esprit que la trajectoire des jauges : le seuil dit où l'on est, la
//! projection dit où l'on va. Et mêmes refus, pour les mêmes raisons :
//!
//!  - **Pas de rythme, pas de projection.** Il faut au moins trois jours de
//!    données : extrapoler une mensualité depuis une matinée annoncerait des
//!    dépassements imaginaires.
//!  - **Pas d'activité récente, pas de projection.** Un rythme nul ne dépasse
//!    jamais rien ; afficher « fin de mois : même montant » n'apprendrait
//!    rien de plus que la dépense elle-même.
//!  - **Un prix inconnu se dit.** Si un modèle n'a pas de tarif, la dépense
//!    est un plancher, et l'interface l'annonce.
//!
//! Les montants sont en dollars, comme les tarifs publiés : les convertir
//! demanderait un taux de change, donc une requête réseau de plus, absente de
//! la liste exhaustive que la politique de confidentialité s'est donnée.

use crate::collectors::Event;
use crate::models::resolve_model;
use crate::pricing::cost;
use crate::provenance;
use crate::store::Config;
use crate::util::Tokens;
use chrono::{Datelike, Local, TimeZone};
use serde::Serialize;
use std::collections::HashMap;

const DAY_MS: i64 = 86_400_000;

/// Fenêtre sur laquelle on mesure le rythme récent.
const PACE_DAYS: i64 = 7;

/// Ancienneté minimale des données pour oser une projection.
const MIN_HISTORY_DAYS: i64 = 3;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    #[serde(rename = "limitUSD")]
    pub limit_usd: f64,
    #[serde(rename = "spentUSD")]
    pub spent_usd: f64,
    /// Dépense sur le plafond, en pourcentage. Peut dépasser 100.
    pub percent: f64,
    /// Fin de mois au rythme des sept derniers jours ; absent quand on refuse
    /// de projeter (voir l'en-tête du module).
    #[serde(rename = "projectedUSD", skip_serializing_if = "Option::is_none")]
    pub projected_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected_percent: Option<f64>,
    /// Vrai si au moins un modèle n'a pas de tarif : la dépense est alors un
    /// plancher.
    pub cost_incomplete: bool,
    pub month_start: i64,
    pub month_end: i64,
    /// `ok`, `projected-over` (la projection dépasse) ou `over` (déjà dépassé).
    pub state: &'static str,
}

/// Début du mois local contenant `now`, et début du suivant.
pub fn month_bounds(now: i64) -> (i64, i64) {
    let local = Local
        .timestamp_millis_opt(now)
        .single()
        .unwrap_or_else(Local::now);
    let start_of = |year: i32, month: u32| {
        Local
            .with_ymd_and_hms(year, month, 1, 0, 0, 0)
            // Une heure de bascule d'heure d'été peut manquer à minuit : on
            // prend alors la première qui existe.
            .earliest()
            .map(|d| d.timestamp_millis())
    };
    let (ny, nm) = if local.month() == 12 {
        (local.year() + 1, 1)
    } else {
        (local.year(), local.month() + 1)
    };
    let start = start_of(local.year(), local.month()).unwrap_or(now - 15 * DAY_MS);
    let end = start_of(ny, nm).unwrap_or(now + 15 * DAY_MS);
    (start, end)
}

/// Coût de plusieurs plages, en une seule déduplication.
///
/// La déduplication mesure/facturé se fait sur l'historique COMPLET (voir
/// `aggregate::report`) : la refaire par plage compterait deux fois les mêmes
/// requêtes vues par deux sources. Rend, pour chaque plage `[from, to]`, le
/// coût et un drapeau « un tarif manquait ».
pub fn costs_between(events: &[Event], ranges: &[(i64, i64)], config: &Config) -> Vec<(f64, bool)> {
    let (measured, _) = provenance::dedupe_families(events);
    ranges
        .iter()
        .map(|&(from, to)| {
            let mut per_model: HashMap<&str, Tokens> = HashMap::new();
            for e in measured.iter().filter(|e| e.ts >= from && e.ts <= to) {
                per_model
                    .entry(e.model.as_str())
                    .or_insert_with(Tokens::empty)
                    .add(&e.tokens);
            }
            let mut total = 0.0;
            let mut unknown = false;
            for (id, tokens) in per_model {
                let model = resolve_model(id, Some(&config.model_overrides));
                match cost(&tokens, &model) {
                    Some(c) => total += c,
                    None => unknown = true,
                }
            }
            (total, unknown)
        })
        .collect()
}

/// L'état du budget, ou `None` si aucun plafond n'est fixé.
pub fn status(events: &[Event], config: &Config, now: i64) -> Option<BudgetStatus> {
    let limit = config
        .budget_monthly_usd
        .filter(|l| l.is_finite() && *l > 0.0)?;
    let (month_start, month_end) = month_bounds(now);

    let pace_from = now - PACE_DAYS * DAY_MS;
    let costs = costs_between(events, &[(month_start, now), (pace_from, now)], config);
    let (spent, spent_unknown) = costs[0];
    let (recent, recent_unknown) = costs[1];

    let percent = spent / limit * 100.0;

    // Ancienneté réelle des données : un rythme mesuré sur trois jours vaut
    // un rythme, sur trois heures il ne vaut rien.
    let oldest = events.iter().map(|e| e.ts).min();
    let history_days = oldest.map_or(0, |o| (now - o) / DAY_MS);
    let projected = (history_days >= MIN_HISTORY_DAYS && recent > 0.0).then(|| {
        // Si les données sont plus récentes que la fenêtre, on divise par
        // leur durée réelle : diviser par sept sous-estimerait le rythme.
        let span_days = history_days.clamp(MIN_HISTORY_DAYS, PACE_DAYS) as f64;
        let per_day = recent / span_days;
        let remaining_days = (month_end - now).max(0) as f64 / DAY_MS as f64;
        spent + per_day * remaining_days
    });

    let state = if spent >= limit {
        "over"
    } else if projected.is_some_and(|p| p > limit) {
        "projected-over"
    } else {
        "ok"
    };

    Some(BudgetStatus {
        limit_usd: limit,
        spent_usd: spent,
        percent,
        projected_usd: projected,
        projected_percent: projected.map(|p| p / limit * 100.0),
        cost_incomplete: spent_unknown || recent_unknown,
        month_start,
        month_end,
        state,
    })
}
