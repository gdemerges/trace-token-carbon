//! Ce que la barre d'état affiche, et pour quelle fenêtre.
//!
//! Ces décisions n'ont rien d'électronique ni de graphique : ce sont des
//! choix d'affichage à partir d'un instantané. Elles vivent donc dans le
//! cœur, où elles s'éprouvent sans lancer d'interface — exactement la raison
//! pour laquelle la version Electron les avait sorties de son processus
//! principal.

use crate::core::Snapshot;
use crate::i18n::{t, t1, tp};
use crate::ratelimits::Gauge;
use crate::store::Config;

/// La jauge à lire d'un coup d'œil : la fenêtre la plus COURTE.
///
/// C'était la plus remplie, ce qui désignait presque toujours l'hebdomadaire —
/// la jauge qui monte lentement, et sur laquelle on ne décide rien dans
/// l'heure. Or ce qu'on cherche dans la barre, c'est ce qui bloquera en
/// premier : la session de cinq heures. C'est elle qu'on peut encore
/// infléchir, et c'est son remplissage que l'icône doit montrer.
///
/// À durée de fenêtre égale, la plus remplie l'emporte. L'hebdomadaire n'est
/// pas perdu de vue pour autant : l'infobulle le donne ligne à ligne, et les
/// alertes surveillent toutes les jauges.
pub fn primary_gauge(snapshot: &Snapshot) -> Option<&Gauge> {
    snapshot
        .gauges
        .iter()
        .filter(|g| g.percent.is_some())
        .reduce(|a, b| {
            let (ha, hb) = (a.window_hours, b.window_hours);
            if ha != hb {
                if hb < ha {
                    b
                } else {
                    a
                }
            } else if b.percent > a.percent {
                b
            } else {
                a
            }
        })
}

/// Texte de la barre d'état, selon la métrique choisie.
///
/// Il partage la largeur avec l'horloge et tout ce que l'utilisateur y a déjà
/// mis : chaque caractère se paie. D'où les unités compactes, et le tiret
/// quand il n'y a rien de sûr à dire — un « 0 % » inventé serait pire que
/// rien.
pub fn tray_title(snapshot: &Snapshot, config: &Config) -> String {
    let totals = &snapshot.report.totals;
    match config.tray_metric.as_str() {
        "tokens" => {
            let n = totals.tokens.total as f64;
            if n >= 1e9 {
                format!("{:.1} Md", n / 1e9)
            } else {
                format!("{} M", (n / 1e6).round())
            }
        }
        "cost" => format!("${:.0}", totals.cost_usd),
        "carbon" => format!("{:.1} kg", totals.carbon.grams_co2e.mid / 1000.0),
        // `session` et tout réglage inconnu : la fenêtre qui bloquera en premier.
        _ => match primary_gauge(snapshot).and_then(|g| g.percent) {
            Some(p) => format!("{} %", p.round()),
            None => t("tray.none"),
        },
    }
}

/// Une ligne par fenêtre, plus le total de la période.
pub fn tray_tooltip(snapshot: &Snapshot) -> String {
    let mut lines = vec!["TRACE".to_string()];

    for g in &snapshot.gauges {
        let pct = match g.percent {
            Some(p) => format!("{} %", p.round()),
            None => t("tray.none"),
        };
        // La trajectoire ne tient pas dans le titre de la barre, mais
        // l'infobulle a la place : c'est là qu'elle rend le plus de service,
        // puisqu'on y passe précisément quand on se demande s'il faut lever
        // le pied.
        let proj = match g.projection.as_ref().filter(|p| p.before_reset) {
            Some(p) => {
                let key = if p.throttled {
                    "tray.fullThrottled"
                } else {
                    "tray.full"
                };
                format!(" · {}", t1(key, "when", duration_label(p.in_ms)))
            }
            None => String::new(),
        };
        let label = if g.full_label.is_empty() {
            &g.label
        } else {
            &g.full_label
        };
        lines.push(format!("{label} : {pct}{proj}"));
    }

    let totals = &snapshot.report.totals;
    lines.push(tp(
        "tray.totals",
        &[
            ("days", snapshot.range.days.to_string()),
            ("cost", format!("${:.2}", totals.cost_usd)),
            (
                "carbon",
                format!("{:.1} kg", totals.carbon.grams_co2e.mid / 1000.0),
            ),
        ],
    ));
    lines.join("\n")
}

/// Durée compacte, pour une infobulle : « 42 min », « 3 h 10 », « 2 j ».
pub fn duration_label(ms: f64) -> String {
    if !ms.is_finite() || ms <= 0.0 {
        return t("duration.moment");
    }
    let ms = ms as i64;
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    if h >= 24 {
        t1("duration.days", "n", h / 24)
    } else if h > 0 {
        tp(
            "duration.hoursMinutes",
            &[("h", h.to_string()), ("m", format!("{m:02}"))],
        )
    } else {
        t1("duration.minutes", "n", m)
    }
}

/// Le remplissage à peindre dans l'icône : 0..1, ou rien à montrer.
pub fn tray_fill(snapshot: &Snapshot) -> Option<f64> {
    primary_gauge(snapshot)
        .and_then(|g| g.percent)
        .map(|p| (p / 100.0).clamp(0.0, 1.0))
}
