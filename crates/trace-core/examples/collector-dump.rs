//! Vidage du collecteur Claude Code sur les journaux réels de la machine, pour
//! la comparaison différentielle avec la version JS. Non distribué.

use trace_core::collectors::{claude_code, CollectorState};

fn main() {
    let state = CollectorState::default();
    // `TRACE_CC_DIR` permet de viser une copie gelée des journaux : les vrais
    // sont écrits pendant qu'on les lit, et l'écart d'une exécution à l'autre
    // se confondrait avec un écart de portage.
    let dir = std::env::var("TRACE_CC_DIR").ok();
    let r = claude_code::collect(dir.as_deref(), &state);

    println!("#events\t{}", r.events.len());
    println!("#quota\t{}", r.quota.len());
    println!("#dups\t{}", r.stats.skipped_duplicates);
    println!("#files\t{}", r.stats.files);

    // Ordre stable : le parcours du système de fichiers n'est pas garanti
    // identique entre deux implémentations, seul le contenu doit l'être.
    let mut rows: Vec<String> = r
        .events
        .iter()
        .map(|e| {
            let t = &e.tokens;
            format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                e.ts,
                e.source,
                e.model,
                e.project.as_deref().unwrap_or(""),
                e.session.as_deref().unwrap_or(""),
                t.input,
                t.output,
                t.cache_read,
                t.cache_write,
                t.cache_write5m,
                t.cache_write1h,
                t.thinking,
                t.total,
                e.requests
            )
        })
        .collect();
    rows.sort();
    for r in &rows {
        println!("{r}");
    }

    let mut q: Vec<String> = r
        .quota
        .iter()
        .map(|x| {
            format!(
                "{}\t{}\t{}\t{}\t{}\t{}",
                x.ts,
                x.kind,
                x.status.as_deref().unwrap_or(""),
                x.resets_at,
                x.using_overage,
                format!("{:?}", x.cause).to_lowercase()
            )
        })
        .collect();
    q.sort();
    for r in &q {
        println!("{r}");
    }
}
