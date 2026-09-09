//! Vidage carbone de référence, pour la comparaison différentielle avec la
//! version JS. Non distribué.

use trace_core::carbon::{self, Options, Pair};
use trace_core::models::resolve_model;
use trace_core::util::Tokens;

fn tk(i: i64, o: i64, cr: i64, cw: i64) -> Tokens {
    Tokens {
        input: i,
        output: o,
        cache_read: cr,
        cache_write: cw,
        ..Tokens::empty()
    }
}

/// Même rendu que `Number.prototype.toExponential(10)` de JS, qui écrit le
/// signe de l'exposant même positif. Sans ça la comparaison achoppe sur la
/// mise en forme au lieu de comparer les nombres.
fn f(x: f64) -> String {
    let s = format!("{x:.10e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("chemin du fichier d'identifiants");
    let ids = std::fs::read_to_string(path).unwrap();
    let vectors = [
        tk(1000, 500, 0, 0),
        tk(0, 10000, 0, 0),
        tk(50_000, 1200, 3_000_000, 45_000),
        tk(0, 0, 0, 0),
        tk(7, 3, 11, 2),
    ];
    let opts = Options::default();

    for id in ids.trim().lines() {
        let m = resolve_model(id, None);
        for v in &vectors {
            let e = carbon::estimate(v, &m, &opts);
            println!(
                "{id}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                f(e.grams_co2e.min),
                f(e.grams_co2e.mid),
                f(e.grams_co2e.max),
                f(e.energy_wh.min),
                f(e.energy_wh.mid),
                f(e.energy_wh.max),
                f(e.water_l.min),
                f(e.water_l.mid),
                f(e.water_l.max),
                f(e.usage_g),
                f(e.embodied_g),
                f(e.gpu_count),
                f(e.grid_intensity),
                e.grid_key,
                format!("{:?}", e.confidence).to_lowercase(),
                e.infra.key
            );
        }
    }

    let models: Vec<_> = ["claude-opus-5", "gpt-5", "modele-inconnu"]
        .iter()
        .map(|id| resolve_model(id, None))
        .collect();
    let pairs: Vec<Pair> = models
        .iter()
        .map(|m| Pair {
            tokens: tk(120_000, 8_000, 5_000_000, 90_000),
            model: m,
        })
        .collect();

    for r in carbon::grid_sensitivity(&pairs, &opts) {
        println!(
            "GRID\t{}\t{}\t{}\t{}\t{}\t{}",
            r.key,
            f(r.intensity),
            f(r.grams_co2e.min),
            f(r.grams_co2e.mid),
            f(r.grams_co2e.max),
            r.ratio.map(f).unwrap_or_else(|| "null".into())
        );
    }
    for l in carbon::uncertainty(&pairs, &opts) {
        println!("LEVER\t{}\t{}", l.key, f(l.ratio));
    }
    for e in carbon::equivalents(123456.0) {
        println!("EQUIV\t{}\t{}", e.key, f(e.amount));
    }
}
