//! Alertes de limite.
//!
//! C'était le trou central de TRACE : l'application savait que vous étiez à
//! 87 % d'une fenêtre et ne disait rien. Un outil dont la raison d'être est de
//! prévenir avant la limite doit prévenir.
//!
//! Trois règles gouvernent ce module, et elles comptent plus que le code :
//!
//!  1. On n'alerte QUE sur une échelle digne de confiance — relevé serveur ou
//!     calage manuel. Jamais sur une estimation : celle déduite d'un refus 429
//!     s'est révélée fausse d'un facteur 2,6, et une alerte fausse détruit la
//!     confiance dans toutes les autres.
//!  2. Une alerte par seuil et par fenêtre. Le franchissement d'un seuil est
//!     un événement, pas un état : répéter la notification à chaque cycle de
//!     soixante secondes transformerait l'outil en nuisance.
//!  3. Une nouvelle fenêtre remet les compteurs à zéro. L'identité d'une
//!     fenêtre inclut son instant de réinitialisation.

use crate::budget::BudgetStatus;
use crate::i18n::{t, tp};
use crate::ratelimits::Gauge;
use crate::store::Config;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub const DEFAULT_THRESHOLDS: [f64; 2] = [80.0, 95.0];

/// Marqueur de l'alerte de trajectoire.
///
/// Il partage la mémoire des seuils — même fenêtre, même remise à zéro à la
/// réinitialisation — mais ne peut être confondu avec un pourcentage.
pub const TRAJECTORY: &str = "trajectoire";

/// Sources d'échelle en lesquelles on a assez confiance pour alerter.
const TRUSTED: [&str; 5] = ["live", "live-stale", "user", "provider", "configured"];

fn is_trusted(source: Option<&str>) -> bool {
    source.is_some_and(|s| TRUSTED.contains(&s))
}

/// Identité d'une fenêtre : elle change à chaque réinitialisation, ce qui
/// réarme les seuils.
///
/// Une fenêtre glissante n'a pas d'instant de réinitialisation annoncé : son
/// début avance en continu. On la quantifie alors à l'heure, ce qui réarme les
/// seuils une fois par heure tant que la consommation reste haute. C'est
/// délibéré : une saturation qui dure une demi-journée mérite plus d'un
/// rappel, mais pas un rappel toutes les minutes.
pub fn window_key(g: &Gauge) -> String {
    match g.resets_at {
        Some(r) if r != 0 => format!("{}@{r}", g.id),
        _ => format!("{}~{}", g.id, g.starts_at / 3_600_000),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub key: String,
    pub gauge_id: String,
    /// Un seuil franchi, ou [`TRAJECTORY`].
    pub threshold: String,
    pub percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected_at: Option<i64>,
    pub title: String,
    pub body: String,
    pub urgency: &'static str,
}

/// Ce qui a déjà été notifié, par fenêtre.
pub type Fired = HashMap<String, Vec<String>>;

pub struct Outcome {
    pub notifications: Vec<Notification>,
    /// Remplace l'état précédent. On ne conserve que les fenêtres encore
    /// vivantes : sans cet élagage, la mémoire grossirait indéfiniment.
    pub state: Fired,
}

fn format_until(ts: i64, now: i64) -> String {
    let ms = ts - now;
    if ms <= 0 {
        return t("duration.imminent");
    }
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    if h >= 24 {
        return tp("duration.inDays", &[("n", (h / 24).to_string())]);
    }
    if h > 0 {
        return tp(
            "duration.inHoursMinutes",
            &[("h", h.to_string()), ("m", format!("{m:02}"))],
        );
    }
    tp("duration.inMinutes", &[("n", m.to_string())])
}

/// Décide quelles notifications émettre.
pub fn evaluate(gauges: &[Gauge], config: &Config, state: &Fired, now: i64) -> Outcome {
    if !config.alerts.enabled {
        return Outcome {
            notifications: Vec::new(),
            state: state.clone(),
        };
    }

    let mut thresholds: Vec<f64> = config
        .alerts
        .thresholds
        .iter()
        .copied()
        .filter(|t| t.is_finite() && *t > 0.0 && *t <= 100.0)
        .collect();
    if thresholds.is_empty() {
        thresholds = DEFAULT_THRESHOLDS.to_vec();
    }
    thresholds.sort_by(f64::total_cmp);

    let mut notifications = Vec::new();
    let mut next: Fired = HashMap::new();

    for g in gauges {
        let Some(percent) = g.percent else { continue };
        if g.approximate || !is_trusted(g.limit_source.as_deref()) {
            continue;
        }

        let key = window_key(g);
        let already: HashSet<&str> = state
            .get(&key)
            .map(|v| v.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let mut fired: Vec<String> = already.iter().map(|s| s.to_string()).collect();

        // --- trajectoire ---------------------------------------------------
        // Le seuil dit où l'on est, la trajectoire dit où l'on va. À 40 % en
        // montant vite, il reste le temps d'agir ; à 80 %, souvent plus. C'est
        // donc AVANT le premier seuil que cette alerte a une valeur, et elle
        // ne se déclenche que là — sinon elle doublerait l'alerte de seuil au
        // lieu de l'anticiper.
        //
        // `before_reset` est la condition qui la rend défendable : atteindre
        // le plafond après la réinitialisation n'est pas un incident, c'est
        // une fenêtre qui se vide à temps.
        if config.alerts.projection && !already.contains(TRAJECTORY) && percent < thresholds[0] {
            if let Some(p) = g.projection.as_ref().filter(|p| p.before_reset) {
                notifications.push(Notification {
                    key: key.clone(),
                    gauge_id: g.id.clone(),
                    threshold: TRAJECTORY.to_string(),
                    percent,
                    projected_at: Some(p.at),
                    title: tp(
                        "alert.trajectory.title",
                        &[
                            (
                                "product",
                                if g.product.is_empty() {
                                    t("alert.limit")
                                } else {
                                    g.product.clone()
                                },
                            ),
                            ("window", g.label.to_lowercase()),
                            ("when", format_until(p.at, now)),
                        ],
                    ),
                    body: tp(
                        "alert.trajectory.body",
                        &[("percent", percent.round().to_string())],
                    ),
                    urgency: "normal",
                });
                fired.push(TRAJECTORY.to_string());
            }
        }

        // Seul le seuil le PLUS HAUT franchi est notifié : passer de 0 à 96 %
        // en un cycle ne doit pas produire deux notifications d'un coup.
        let crossed: Vec<f64> = thresholds
            .iter()
            .copied()
            .filter(|t| percent >= *t && !already.contains(fmt_threshold(*t).as_str()))
            .collect();
        if let Some(top) = crossed.last().copied() {
            notifications.push(Notification {
                key: key.clone(),
                gauge_id: g.id.clone(),
                threshold: fmt_threshold(top),
                percent,
                projected_at: None,
                title: tp(
                    "alert.threshold.title",
                    &[
                        (
                            "product",
                            if g.product.is_empty() {
                                t("alert.limit")
                            } else {
                                g.product.clone()
                            },
                        ),
                        ("percent", percent.round().to_string()),
                        ("window", g.label.to_lowercase()),
                    ],
                ),
                body: match g.resets_at.filter(|r| *r != 0) {
                    Some(r) => tp("alert.threshold.reset", &[("when", format_until(r, now))]),
                    None => t("alert.threshold.rolling"),
                },
                urgency: if top >= 95.0 { "critical" } else { "normal" },
            });
            fired.extend(crossed.into_iter().map(fmt_threshold));
        }

        if !fired.is_empty() {
            fired.sort();
            fired.dedup();
            next.insert(key, fired);
        }
    }

    Outcome {
        notifications,
        state: next,
    }
}

/// Formate un montant en dollars pour une notification : sans décimales dès
/// que les centimes ne changent plus rien à la lecture.
fn dollars(v: f64) -> String {
    if v >= 100.0 {
        format!("${v:.0}")
    } else {
        format!("${v:.2}")
    }
}

/// Décide des notifications de budget.
///
/// Mêmes règles que pour les jauges : un franchissement est un événement, on
/// ne notifie que le seuil le PLUS HAUT franchi, et la projection ne parle
/// qu'AVANT le premier seuil — plus tard, elle doublerait l'alerte de seuil.
/// Le mois, lui, remplace la fenêtre : son début identifie l'état, donc un
/// nouveau mois réarme tout.
///
/// `state` est la mémoire propre au budget, distincte de celle des jauges :
/// `evaluate` élague tout ce qui n'est pas une fenêtre vivante.
pub fn evaluate_budget(budget: Option<&BudgetStatus>, config: &Config, state: &Fired) -> Outcome {
    let keep = |state: &Fired| Outcome {
        notifications: Vec::new(),
        state: state.clone(),
    };
    let Some(b) = budget else {
        return Outcome {
            notifications: Vec::new(),
            state: HashMap::new(),
        };
    };
    if !config.alerts.enabled {
        return keep(state);
    }

    let mut thresholds: Vec<f64> = config
        .alerts
        .thresholds
        .iter()
        .copied()
        .filter(|t| t.is_finite() && *t > 0.0 && *t <= 100.0)
        .collect();
    if thresholds.is_empty() {
        thresholds = DEFAULT_THRESHOLDS.to_vec();
    }
    thresholds.sort_by(f64::total_cmp);

    let key = format!("budget@{}", b.month_start);
    let already: HashSet<&str> = state
        .get(&key)
        .map(|v| v.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let mut fired: Vec<String> = already.iter().map(|s| s.to_string()).collect();
    let mut notifications = Vec::new();
    let limit = dollars(b.limit_usd);

    if config.alerts.projection && !already.contains(TRAJECTORY) && b.percent < thresholds[0] {
        if let Some(projected) = b.projected_usd.filter(|p| *p > b.limit_usd) {
            notifications.push(Notification {
                key: key.clone(),
                gauge_id: "budget".to_string(),
                threshold: TRAJECTORY.to_string(),
                percent: b.percent,
                projected_at: None,
                title: tp("alert.budget.projected.title", &[("limit", limit.clone())]),
                body: tp(
                    "alert.budget.projected.body",
                    &[
                        ("projected", dollars(projected)),
                        ("spent", dollars(b.spent_usd)),
                    ],
                ),
                urgency: "normal",
            });
            fired.push(TRAJECTORY.to_string());
        }
    }

    let crossed: Vec<f64> = thresholds
        .iter()
        .copied()
        .filter(|t| b.percent >= *t && !already.contains(fmt_threshold(*t).as_str()))
        .collect();
    if let Some(top) = crossed.last().copied() {
        notifications.push(Notification {
            key: key.clone(),
            gauge_id: "budget".to_string(),
            threshold: fmt_threshold(top),
            percent: b.percent,
            projected_at: None,
            title: tp(
                "alert.budget.title",
                &[("percent", b.percent.round().to_string()), ("limit", limit)],
            ),
            body: tp("alert.budget.body", &[("spent", dollars(b.spent_usd))]),
            urgency: if top >= 95.0 { "critical" } else { "normal" },
        });
        fired.extend(crossed.into_iter().map(fmt_threshold));
    }

    let mut next = HashMap::new();
    if !fired.is_empty() {
        fired.sort();
        fired.dedup();
        next.insert(key, fired);
    }
    Outcome {
        notifications,
        state: next,
    }
}

/// Un seuil, écrit comme il est mémorisé. `80` et non `80.0` : l'état est
/// persisté en JSON, et les deux formes ne se compareraient plus.
fn fmt_threshold(t: f64) -> String {
    if t.fract() == 0.0 {
        format!("{}", t as i64)
    } else {
        t.to_string()
    }
}
