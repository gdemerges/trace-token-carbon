//! La forme du JSON qui traverse la frontière avec l'interface.
//!
//! Ces tests existent à cause d'un bug que rien d'autre n'attrapait.
//! `serde(rename_all = "camelCase")` transforme `grams_co2e` en « gramsCo2e »,
//! quand le renderer lit « gramsCO2e ». Les sigles ne survivent pas à la
//! conversion automatique. Les vidages différentiels ne pouvaient pas le voir :
//! ils lisent les structures Rust, pas le JSON qu'elles produisent — et
//! l'écran, lui, se contentait de rester vide.
//!
//! Une clé mal nommée ne casse rien à la compilation, ne casse rien aux tests
//! de calcul, et vide un écran en silence. D'où ce filet-ci.

use serde_json::Value;
use trace_core::aggregate::{report, Options};
use trace_core::collectors::Event;
use trace_core::util::Tokens;

fn sample_report() -> Value {
    let now = trace_core::util::now_ms();
    let events = vec![Event {
        ts: now - 3_600_000,
        source: "claude-code".into(),
        model: "claude-opus-5".into(),
        project: Some("trace".into()),
        session: Some("s".into()),
        tokens: Tokens {
            input: 1000,
            output: 500,
            cache_read: 20_000,
            total: 21_500,
            ..Tokens::empty()
        },
        requests: 1,
        compacted: None,
    }];
    let opts = Options {
        from: Some(now - 86_400_000),
        to: Some(now),
        ..Options::default()
    };
    serde_json::to_value(report(&events, &opts)).expect("le rapport se sérialise")
}

/// Descend un chemin pointé, en traversant le premier élément des tableaux.
fn at<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = v;
    for part in path.split('.') {
        cur = if let Some(name) = part.strip_suffix("[]") {
            cur.get(name)?.as_array()?.first()?
        } else {
            cur.get(part)?
        };
    }
    Some(cur)
}

#[test]
fn les_sigles_gardent_leurs_majuscules() {
    let r = sample_report();
    for path in [
        "totals.costUSD",
        "totals.costWithoutCacheUSD",
        "totals.cacheSavingsUSD",
        "totals.carbon.gramsCO2e",
        "totals.carbon.gramsCO2e.mid",
        "byModel[].costUSD",
        "byModel[].carbon.gramsCO2e",
        "byModel[].models[].costUSD",
        "byProject[].costUSD",
        "daily[].costUSD",
        "daily[].gramsCO2e",
        "hours[].costUSD",
        "hours[].gramsCO2e",
        "totals.carbonSensitivity[].gramsCO2e",
    ] {
        assert!(
            at(&r, path).is_some(),
            "le renderer lit `{path}` : la clé doit exister telle quelle"
        );
    }
}

#[test]
fn aucune_variante_mal_capitalisee_ne_traine() {
    // Le symétrique du test précédent : si `gramsCo2e` réapparaissait à côté
    // de `gramsCO2e`, tout compilerait et l'écran resterait vide.
    let raw = serde_json::to_string(&sample_report()).unwrap();
    for wrong in [
        "gramsCo2e",
        "costUsd",
        "costWithoutCacheUsd",
        "cacheSavingsUsd",
    ] {
        assert!(
            !raw.contains(wrong),
            "`{wrong}` : sigle perdu à la sérialisation"
        );
    }
}

#[test]
fn les_autres_conversions_camel_restent_correctes() {
    // Tout n'est pas à renommer à la main : la conversion automatique est
    // juste dès qu'il n'y a pas de sigle. Ce test dit où s'arrête l'exception.
    let r = sample_report();
    for path in [
        "totals.tokens.cacheRead",
        "totals.tokens.cacheWrite5m",
        "totals.tokens.cacheWrite1h",
        "totals.cacheHitRatio",
        "totals.carbon.energyWh",
        "totals.carbon.waterL",
        "totals.carbon.usageG",
        "totals.carbon.embodiedG",
        "eventCount",
        "billedDaysDropped",
        "trend.previous.costUSD",
    ] {
        assert!(at(&r, path).is_some(), "`{path}` manque");
    }
}
