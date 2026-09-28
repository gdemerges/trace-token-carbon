//! Le rapport carbone en Markdown : un livrable qu'on peut joindre à un bilan.
//!
//! Il reprend l'instantané tel qu'affiché et y joint ce qui le rend
//! contestable : la sensibilité au mix électrique, les leviers d'incertitude,
//! et la table des facteurs avec sa citation. Un total sans ces éléments
//! demande qu'on le croie ; avec eux, on peut le vérifier.
//!
//! Deux refus, hérités du reste de l'application :
//!
//!  - **Une fourchette, jamais un point.** Le total s'écrit min — médiane —
//!    max, comme à l'écran.
//!  - **Ce qui n'est pas figé se dit.** Tant qu'une source n'est pas relevée
//!    sur sa publication, le rapport le proclame en tête plutôt que de laisser
//!    croire à un document audité.

use crate::carbon::factors::factor_table;
use crate::carbon::sources::unpinned_sources;
use crate::core::Snapshot;
use crate::i18n::{t, tp};
use crate::models::Range;
use chrono::{Local, TimeZone};
use std::fmt::Write;

/// Échappe une cellule de tableau. Les noms de modèles viennent de journaux
/// analysés : un `|` y couperait la ligne, un saut de ligne la casserait.
fn cell(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace(['\n', '\r'], " ")
}

fn date(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// Des grammes, à l'échelle lisible : en dessous du kilo on reste en grammes.
fn grams(g: f64) -> String {
    if g >= 1_000_000.0 {
        format!("{:.2} t", g / 1_000_000.0)
    } else if g >= 1_000.0 {
        format!("{:.2} kg", g / 1_000.0)
    } else if g >= 10.0 {
        format!("{g:.0} g")
    } else {
        format!("{g:.2} g")
    }
}

fn wh(v: f64) -> String {
    if v >= 1_000.0 {
        format!("{:.2} kWh", v / 1_000.0)
    } else {
        format!("{v:.1} Wh")
    }
}

fn litres(v: f64) -> String {
    format!("{v:.2} L")
}

fn range_row(label: &str, r: &Range, fmt: fn(f64) -> String) -> String {
    format!(
        "| {} | {} | {} | {} |\n",
        cell(label),
        fmt(r.min),
        fmt(r.mid),
        fmt(r.max)
    )
}

/// Construit le rapport pour l'instantané donné.
pub fn carbon_report(snap: &Snapshot) -> String {
    let tot = &snap.report.totals;
    let mut md = String::new();
    // `write!` sur une `String` ne peut pas échouer.
    let mut w = |s: &str| {
        let _ = md.write_str(s);
    };

    w(&format!("# {}\n\n", t("report.title")));
    w(&tp(
        "report.period",
        &[
            ("from", date(snap.range.from)),
            ("to", date(snap.range.to)),
            ("days", snap.range.days.to_string()),
        ],
    ));
    w("  \n");
    w(&tp(
        "report.generated",
        &[
            ("date", date(snap.generated_at)),
            ("version", env!("CARGO_PKG_VERSION").to_string()),
        ],
    ));
    w("\n\n");

    // --- avertissement de provenance ------------------------------------
    let unpinned = unpinned_sources();
    if !unpinned.is_empty() {
        w(&format!(
            "> **{}** {}\n>\n",
            t("report.notAuditedTitle"),
            tp("report.notAudited", &[("n", unpinned.len().to_string())])
        ));
        for s in &unpinned {
            w(&format!("> - {} — {}\n", cell(s.publisher), cell(s.label)));
        }
        w("\n");
    }

    // --- synthèse ---------------------------------------------------------
    w(&format!("## {}\n\n", t("report.summary")));
    w(&format!(
        "| {} | {} | {} | {} |\n|---|---:|---:|---:|\n",
        t("report.metric"),
        t("report.low"),
        t("report.mid"),
        t("report.high")
    ));
    w(&range_row("CO₂e", &tot.carbon.grams_co2e, grams));
    w(&range_row(&t("report.energy"), &tot.carbon.energy_wh, wh));
    w(&range_row(&t("report.water"), &tot.carbon.water_l, litres));
    w("\n");
    w(&format!(
        "- {}\n- {}\n",
        tp(
            "report.tokens",
            &[
                ("tokens", tot.tokens.total.to_string()),
                ("requests", tot.requests.to_string())
            ]
        ),
        tp(
            "report.grid",
            &[("grid", snap.config.carbon.grid_key.clone())]
        ),
    ));
    if !tot.cost_unknown {
        w(&format!(
            "- {}\n",
            tp("report.cost", &[("cost", format!("{:.2}", tot.cost_usd))])
        ));
    }
    w("\n");

    // --- par modèle ---------------------------------------------------------
    if !snap.report.by_model.is_empty() {
        w(&format!("## {}\n\n", t("report.byModel")));
        w(&format!(
            "| {} | {} | CO₂e ({}) | {} |\n|---|---:|---:|---:|\n",
            t("report.model"),
            t("report.tokensCol"),
            t("report.mid"),
            t("report.share")
        ));
        let total_g = tot.carbon.grams_co2e.mid;
        let label_of = |g: &crate::aggregate::Group| {
            g.models.first().map_or(g.key.clone(), |m| m.label.clone())
        };
        for g in &snap.report.by_model {
            // Deux identifiants peuvent partager un libellé (`claude-sonnet-5`
            // et sa révision) : sans l'identifiant, le tableau porte deux lignes
            // identiques et le lecteur croit à un doublon.
            let base = label_of(g);
            let ambiguous = snap
                .report
                .by_model
                .iter()
                .filter(|o| label_of(o) == base)
                .count()
                > 1;
            let label = if ambiguous {
                format!("{base} ({})", g.key)
            } else {
                base
            };
            let share = if total_g > 0.0 {
                format!("{:.0} %", g.carbon.grams_co2e.mid / total_g * 100.0)
            } else {
                "—".to_string()
            };
            w(&format!(
                "| {} | {} | {} | {} |\n",
                cell(&label),
                g.tokens.total,
                grams(g.carbon.grams_co2e.mid),
                share
            ));
        }
        w("\n");
    }

    // --- sensibilité --------------------------------------------------------
    if !tot.carbon_sensitivity.is_empty() {
        w(&format!(
            "## {}\n\n{}\n\n",
            t("report.sensitivity"),
            t("report.sensitivityNote")
        ));
        w(&format!(
            "| {} | g/kWh | CO₂e ({}) | {} |\n|---|---:|---:|---:|\n",
            t("report.gridCol"),
            t("report.mid"),
            t("report.ratio")
        ));
        for r in &tot.carbon_sensitivity {
            w(&format!(
                "| {} | {:.0} | {} | {} |\n",
                cell(&r.label),
                r.intensity,
                grams(r.grams_co2e.mid),
                r.ratio.map_or("—".to_string(), |x| format!("× {x:.2}"))
            ));
        }
        w("\n");
    }

    // --- incertitude --------------------------------------------------------
    if !tot.carbon_uncertainty.is_empty() {
        w(&format!(
            "## {}\n\n{}\n\n",
            t("report.uncertainty"),
            t("report.uncertaintyNote")
        ));
        w(&format!(
            "| {} | {} |\n|---|---:|\n",
            t("report.lever"),
            t("report.spread")
        ));
        for l in &tot.carbon_uncertainty {
            w(&format!("| {} | × {:.1} |\n", cell(l.label), l.ratio));
        }
        w("\n");
    }

    // --- méthode ------------------------------------------------------------
    w(&format!(
        "## {}\n\n{}\n\n",
        t("report.method"),
        t("report.methodBody")
    ));

    // --- facteurs -----------------------------------------------------------
    w(&format!(
        "## {}\n\n{}\n\n",
        t("report.factors"),
        t("report.factorsNote")
    ));
    w(&format!(
        "| {} | {} | {} | {} | {} |\n|---|---|---:|---|---|\n",
        t("report.group"),
        t("report.factor"),
        t("report.value"),
        t("report.unit"),
        t("report.pinned")
    ));
    for f in factor_table(Some(&snap.config.carbon.grid_key)) {
        w(&format!(
            "| {} | {} | {} | {} | {} |\n",
            cell(f.group),
            cell(&f.key),
            cell(&f.value),
            cell(f.unit),
            if f.pinned {
                t("report.yes")
            } else {
                t("report.no")
            }
        ));
    }
    w("\n");

    md
}
