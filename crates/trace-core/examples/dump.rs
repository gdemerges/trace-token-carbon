//! Vidage de référence, pour la comparaison différentielle avec la version JS.
//! Non distribué : c'est l'outil qui prouve que le portage ne change pas les
//! chiffres, ligne à ligne.

use trace_core::models::resolve_model;
use trace_core::pricing::{cost, cost_without_cache};
use trace_core::util::Tokens;

fn tk(i: i64, o: i64, cr: i64, cw: i64, w5: i64, w1: i64) -> Tokens {
    Tokens { input: i, output: o, cache_read: cr, cache_write: cw, cache_write5m: w5, cache_write1h: w1, thinking: 0, total: 0 }
}

fn main() {
    let path = std::env::args().nth(1).expect("chemin du fichier d'identifiants");
    let ids = std::fs::read_to_string(path).unwrap();
    let vectors = [
        tk(1_000_000, 0, 0, 0, 0, 0),
        tk(0, 1_000_000, 0, 0, 0, 0),
        tk(1234, 567, 987_654, 0, 4321, 99),
        tk(0, 0, 0, 55_555, 0, 0),
        tk(0, 0, 0, 0, 0, 0),
    ];
    let f = |v: Option<f64>| match v {
        Some(x) => format!("{x:.12}"),
        None => "null".to_string(),
    };
    for id in ids.trim().lines() {
        let m = resolve_model(id, None);
        let mut row = vec![
            id.to_string(),
            m.id.clone(),
            m.label.clone(),
            m.provider.clone(),
            m.family.clone(),
            match m.pricing {
                Some(p) => format!("{}/{}", p.input, p.output),
                None => "null".into(),
            },
            match m.context { Some(c) => c.to_string(), None => "null".into() },
            format!("{:?}", m.params.confidence).to_lowercase(),
            match m.params.source {
                trace_core::models::ParamSource::InferredFromBehaviour => "inferredFromBehaviour".into(),
                trace_core::models::ParamSource::TraceDerived => "traceDerived".into(),
            },
            format!("{}-{}", m.params.total.min, m.params.total.max),
            format!("{}-{}", m.params.active.min, m.params.active.max),
        ];
        for v in &vectors {
            row.push(f(cost(v, &m)));
            row.push(f(cost_without_cache(v, &m)));
        }
        println!("{}", row.join("\t"));
    }
}
