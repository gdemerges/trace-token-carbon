//! Vidage du rapport complet sur les journaux réels, pour la comparaison
//! différentielle avec la version JS. Non distribué.

use trace_core::aggregate::{report, Options};
use trace_core::collectors::{claude_code, CollectorState};

/// Bornes FIXES : `now()` des deux côtés donnerait deux périodes différentes,
/// et l'écart se lirait comme un écart de portage.
const TO: i64 = 1_788_900_000_000;
const FROM: i64 = TO - 30 * 86_400_000;

fn f(x: f64) -> String {
    let s = format!("{x:.10e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}
fn fo(x: Option<f64>) -> String {
    x.map(f).unwrap_or_else(|| "null".into())
}

fn main() {
    let dir = std::env::var("TRACE_CC_DIR").ok();
    let collected = claude_code::collect(dir.as_deref(), &CollectorState::default());
    let opts = Options { from: Some(FROM), to: Some(TO), ..Options::default() };
    let rep = report(&collected.events, &opts);

    println!("eventCount\t{}", rep.event_count);
    println!("billedDaysDropped\t{}", rep.billed_days_dropped);
    let t = &rep.totals;
    let k = &t.tokens;
    println!(
        "tokens\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
        k.input, k.output, k.cache_read, k.cache_write, k.cache_write5m, k.cache_write1h, k.thinking, k.total
    );
    println!("requests\t{}", t.requests);
    println!(
        "cost\t{}\t{}\t{}\t{}\t{}",
        f(t.cost_usd), f(t.cost_without_cache_usd), f(t.cache_savings_usd), f(t.cache_hit_ratio), t.cost_unknown
    );
    let c = &t.carbon;
    println!(
        "carbon\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
        f(c.grams_co2e.min), f(c.grams_co2e.mid), f(c.grams_co2e.max),
        f(c.energy_wh.mid), f(c.water_l.mid), f(c.usage_g), f(c.embodied_g)
    );
    for s in &t.carbon_sensitivity {
        println!("sens\t{}\t{}\t{}", s.key, f(s.grams_co2e.mid), fo(s.ratio));
    }
    for u in &t.carbon_uncertainty {
        println!("unc\t{}\t{}", u.key, f(u.ratio));
    }
    for e in &t.equivalents {
        println!("equiv\t{}\t{}", e.key, f(e.amount));
    }
    println!(
        "trend\t{}\t{}\t{}\t{}\t{}",
        fo(rep.trend.tokens), fo(rep.trend.cost), fo(rep.trend.carbon),
        rep.trend.previous.tokens.total, f(rep.trend.previous.cost_usd)
    );
    for g in &rep.by_model {
        let inner: Vec<String> = g.models.iter().map(|m| format!("{}:{}", m.id, m.tokens.total)).collect();
        println!("model\t{}\t{}\t{}\t{}\t{}\t{}", g.key, g.tokens.total, g.requests, f(g.cost_usd), f(g.carbon.grams_co2e.mid), inner.join(","));
    }
    for g in &rep.by_project {
        println!("project\t{}\t{}\t{}\t{}\t{}", g.key, g.tokens.total, g.requests, f(g.cost_usd), f(g.carbon.grams_co2e.mid));
    }
    for d in &rep.daily {
        let inner: Vec<String> = d.models.iter().map(|m| format!("{}:{}", m.id, m.total)).collect();
        println!("day\t{}\t{}\t{}\t{}\t{}\t{}\t{}", d.date, d.ts, d.tokens.total, d.requests, f(d.cost_usd), f(d.grams_co2e), inner.join(","));
    }
    for h in &rep.hours {
        println!("hour\t{}\t{}\t{}\t{}\t{}", h.hour, h.tokens, h.requests, f(h.cost_usd), f(h.grams_co2e));
    }
    for rc in &rep.reconciliation {
        println!("recon\t{}\t{}\t{}\t{}\t{}", rc.family, rc.local, rc.billed, fo(rc.delta_pct), rc.days.len());
    }
}
