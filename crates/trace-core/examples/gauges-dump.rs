//! Vidage des jauges, pour la comparaison différentielle avec la version JS.
//! Non distribué.

use trace_core::collectors::{Cause, CollectorState, Quota};
use trace_core::ratelimits::{compute_gauges, duration_label, weighted_usage, Gauge};
use trace_core::store::Config;
use trace_core::util::Tokens;

const NOW: i64 = 1_788_900_000_000;

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
fn io_(x: Option<i64>) -> String {
    x.map(|v| v.to_string()).unwrap_or_else(|| "null".into())
}

fn live(source: &str, kind: &str, percent: f64, resets_at: i64, ts: i64) -> Quota {
    Quota {
        source: source.into(),
        ts,
        kind: kind.into(),
        status: None,
        resets_at,
        using_overage: false,
        cause: Cause::Window,
        used_percent: Some(percent),
        window_minutes: None,
        plan: None,
    }
}

fn main() {
    let dir = std::env::var("TRACE_CC_DIR").ok();
    let r = trace_core::collectors::claude_code::collect(dir.as_deref(), &CollectorState::default());
    let config = Config::default();

    let line = |g: &Gauge| {
        format!(
            "gauge\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            g.id, g.provider, g.label, g.window_hours, g.starts_at, io_(g.resets_at), g.rolling,
            g.tokens.total, g.requests, f(g.used), fo(g.limit),
            g.limit_source.as_deref().unwrap_or("null"), fo(g.percent),
            g.approximate, g.stale, g.calibratable,
            g.calibration.as_ref().map(|c| format!("{}/{}", f(c.limit), c.samples)).unwrap_or_else(|| "null".into()),
            g.projection.as_ref().map(|p| format!("{}/{}/{}", f(p.in_ms), p.throttled, p.before_reset)).unwrap_or_else(|| "null".into()),
        )
    };
    for g in compute_gauges(&r.events, &r.quota, &config, NOW) {
        println!("{}", line(&g));
    }

    // Jauges avec relevé direct simulé : le chemin qui compte en usage réel.
    let mut with_live = r.quota.clone();
    with_live.push(live("anthropic-oauth", "five_hour", 80.0, NOW + 3 * 3_600_000, NOW - 5 * 60_000));
    with_live.push(live("anthropic-oauth", "weekly", 45.0, NOW + 3 * 86_400_000, NOW - 5 * 60_000));
    let mut codex = live("codex-cli", "monthly", 18.0, NOW + 20 * 86_400_000, NOW - 20 * 60_000);
    codex.window_minutes = Some(43_200.0);
    codex.plan = Some("plus".into());
    with_live.push(codex);

    for g in compute_gauges(&r.events, &with_live, &config, NOW) {
        println!(
            "live\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            g.id, g.label, g.window_hours, io_(g.resets_at), g.rolling, f(g.used),
            fo(g.percent), g.limit_source.as_deref().unwrap_or("null"), g.stale, g.calibratable,
            g.plan.as_deref().unwrap_or("null"),
            g.projection.as_ref().map(|p| format!("{}/{}/{}/{}", f(p.in_ms), f(p.rate_per_hour), p.throttled, p.before_reset)).unwrap_or_else(|| "null".into()),
        );
    }

    println!(
        "weighted\t{}",
        f(weighted_usage(&Tokens { input: 1000, output: 200, cache_write: 3000, cache_read: 900_000, ..Tokens::empty() }))
    );
    for h in [1.0, 5.0, 24.0, 168.0, 720.0, 336.0] {
        println!("dur\t{}\t{}", h as i64, duration_label(h));
    }
}
