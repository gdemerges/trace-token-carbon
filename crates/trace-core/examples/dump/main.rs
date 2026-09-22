//! Vidages de référence du cœur, en TSV ou en JSON. Non distribué.
//!
//! C'est l'outil qui a prouvé, ligne à ligne, que le portage depuis la
//! version JS ne changeait pas les chiffres ; il sert désormais à comparer
//! deux versions du cœur entre elles, ou à inspecter ce qu'une source lit.
//!
//! ```text
//! cargo run -p trace-core --example dump -- <vidage> [arguments]
//! ```
//!
//! `TRACE_CC_DIR` et `TRACE_CODEX_DIR` visent une copie gelée des journaux :
//! les vrais sont écrits pendant qu'on les lit.

mod aggregate;
mod billing;
mod carbon;
mod codex;
mod collector;
mod export;
mod gauges;
mod live;
mod pricing;
mod snapshot;

/// Même rendu que `Number.prototype.toExponential(10)` de JS, qui écrit le
/// signe de l'exposant même positif : deux vidages se comparent sur les
/// nombres, pas sur leur mise en forme.
pub fn f(x: f64) -> String {
    let s = format!("{x:.10e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

pub fn fo(x: Option<f64>) -> String {
    x.map(f).unwrap_or_else(|| "null".into())
}

const DUMPS: &[(&str, &str, fn())] = &[
    (
        "pricing",
        "<ids> : modèle résolu et coût, par identifiant",
        pricing::run,
    ),
    (
        "carbon",
        "<ids> : estimation carbone, sensibilité, leviers",
        carbon::run,
    ),
    (
        "collector",
        "événements et quotas lus dans Claude Code",
        collector::run,
    ),
    ("codex", "événements et quotas lus dans Codex", codex::run),
    (
        "aggregate",
        "rapport complet sur 30 jours fixes",
        aggregate::run,
    ),
    ("export", "export CSV, données et méthodologie", export::run),
    (
        "gauges",
        "jauges, avec et sans relevé direct simulé",
        gauges::run,
    ),
    (
        "billing",
        "analyse des rapports de facturation",
        billing::run,
    ),
    (
        "live",
        "relevé direct Anthropic (sans jamais afficher le jeton)",
        live::run,
    ),
    (
        "snapshot",
        "l'instantané JSON tel qu'il part vers l'interface",
        snapshot::run,
    ),
];

fn main() {
    let which = std::env::args().nth(1).unwrap_or_default();
    match DUMPS.iter().find(|(name, _, _)| *name == which) {
        Some((_, _, run)) => run(),
        None => {
            eprintln!("usage : cargo run -p trace-core --example dump -- <vidage> [arguments]\n");
            for (name, help, _) in DUMPS {
                eprintln!("  {name:<10} {help}");
            }
            std::process::exit(2);
        }
    }
}
