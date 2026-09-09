//! Éprouve le relevé direct de bout en bout : trousseau, appel, extraction.
//! N'affiche JAMAIS le jeton — seulement ce qu'on en fait.

use trace_core::collectors::anthropic_oauth as oauth;

fn main() {
    println!("identifiants trouvés : {}", oauth::is_available());
    let r = oauth::collect(oauth::MIN_INTERVAL_MS, None);
    if let Some(l) = &r.live {
        println!("configuré : {}", l.configured);
        println!("depuis le cache : {}", l.from_cache);
        println!("fenêtres reconnues : {}", l.windows);
        println!("prochain relevé dans : {} s", l.next_attempt_in / 1000);
        println!("erreurs : {:?}", l.errors);
    }
    for q in &r.quota {
        println!(
            "  {} → {:.1} %  réinit. {}",
            q.kind,
            q.used_percent.unwrap_or(0.0),
            if q.resets_at == 0 {
                "inconnue".into()
            } else {
                trace_core::util::day_key(q.resets_at)
            }
        );
    }
}
