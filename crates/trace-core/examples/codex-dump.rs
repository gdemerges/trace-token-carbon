//! Vidage du collecteur Codex sur les rollouts réels. Non distribué.

use trace_core::collectors::{codex_cli, CollectorState};

fn main() {
    let dir = std::env::var("TRACE_CODEX_DIR").ok();
    let r = codex_cli::collect(dir.as_deref(), &CollectorState::default());
    println!("#events\t{}", r.events.len());
    println!("#quota\t{}", r.quota.len());
    println!("#files\t{}", r.stats.files);

    let mut rows: Vec<String> = r.events.iter().map(|e| {
        let t = &e.tokens;
        format!("{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            e.ts, e.model, e.project.as_deref().unwrap_or(""), e.session.as_deref().unwrap_or(""),
            t.input, t.output, t.cache_read, t.cache_write, t.cache_write5m, t.cache_write1h, t.thinking, t.total)
    }).collect();
    rows.sort();
    for r in &rows { println!("{r}"); }

    let mut q: Vec<String> = r.quota.iter().map(|x| {
        format!("{}\t{}\t{}\t{}\t{}\t{}\t{}",
            x.ts, x.kind,
            x.window_minutes.map(|m| m.to_string()).unwrap_or_else(|| "null".into()),
            x.used_percent.unwrap_or(0.0),
            if x.resets_at == 0 { "null".to_string() } else { x.resets_at.to_string() },
            x.plan.as_deref().unwrap_or("null"),
            x.status.as_deref().unwrap_or(""))
    }).collect();
    q.sort();
    for r in &q { println!("{r}"); }
}
