//! Collecteurs de facturation : les rapports d'usage des organisations
//! Anthropic et OpenAI.
//!
//! Contrairement aux collecteurs locaux, ces sources donnent la consommation
//! telle qu'elle est FACTURÉE côté serveur : elles couvrent tous les appareils
//! et toutes les clés de l'organisation, pas seulement cette machine. C'est la
//! référence quand les deux divergent — et c'est aussi pourquoi
//! [`crate::provenance`] les traite comme des agrégats journaliers qui
//! remplacent, jamais comme des requêtes qui s'ajoutent.
//!
//! Les deux exigent une clé Admin ; une clé standard est rejetée, et c'est la
//! cause d'erreur numéro un. Le message le dit plutôt que de laisser un 401
//! nu.

use super::{Collected, Event};
use crate::i18n::t;
use crate::util::{now_ms, parse_flexible_ts, ureq_agent, Tokens};
use serde_json::Value;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);
/// Garde-fou de pagination : une réponse qui ne dit jamais s'arrêter ne doit
/// pas faire tourner la boucle indéfiniment.
const MAX_PAGES: usize = 40;

pub const ANTHROPIC: &str = "anthropic-api";
pub const OPENAI: &str = "openai-api";

const ANTHROPIC_BASE: &str = "https://api.anthropic.com/v1/organizations";
const OPENAI_BASE: &str = "https://api.openai.com/v1/organization";

/// Ces deux sources n'existent que si une clé Admin est renseignée. Le test
/// est le même des deux côtés : autant qu'il n'ait qu'un nom.
pub fn has_key(key: Option<&str>) -> bool {
    key.is_some_and(|k| !k.trim().is_empty())
}

fn agent() -> ureq::Agent {
    ureq_agent(TIMEOUT)
}

/// Exécute une requête et rend le corps JSON, ou un message exploitable.
fn fetch(req: ureq::Request, provider: &str, hint_key: &str) -> Result<Value, String> {
    match req.call() {
        Ok(res) => res.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, res)) => {
            // La cause numéro un est l'usage d'une clé standard là où une clé
            // Admin est requise : on le dit, plutôt que de rendre un 401 nu.
            let hint = if code == 401 || code == 403 {
                t(hint_key)
            } else {
                String::new()
            };
            let body = res.into_string().unwrap_or_default();
            let body: String = body.chars().take(200).collect();
            Err(format!("{provider} {code}{hint}: {body}"))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn n(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}

/// Horodatage d'un seau, quel que soit le nom que l'API lui donne.
fn bucket_ts(b: &Value) -> i64 {
    ["starting_at", "start_time"]
        .into_iter()
        .find_map(|k| parse_flexible_ts(&b[k]))
        .unwrap_or_else(now_ms)
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/// Suit la pagination `has_more` / `next_page`.
fn anthropic_pages(url: &str, params: &[(&str, String)], key: &str) -> Result<Vec<Value>, String> {
    let a = agent();
    let mut out = Vec::new();
    let mut page: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let mut req = a
            .get(url)
            .set("x-api-key", key)
            .set("anthropic-version", "2023-06-01")
            .set("content-type", "application/json");
        for (k, v) in params {
            req = req.query(k, v);
        }
        if let Some(p) = &page {
            req = req.query("page", p);
        }
        let json = fetch(req, "Anthropic", "api.adminKeyHint.anthropic")?;
        if let Some(items) = json["data"].as_array() {
            out.extend(items.iter().cloned());
        }
        match (json["has_more"].as_bool(), json["next_page"].as_str()) {
            (Some(true), Some(next)) => page = Some(next.to_string()),
            _ => break,
        }
    }
    Ok(out)
}

/// Ce que le rapport de coût de l'organisation rapporte.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostReport {
    #[serde(rename = "totalUSD")]
    pub total_usd: f64,
    pub by_day: std::collections::BTreeMap<String, f64>,
}

pub fn collect_anthropic(key: Option<&str>, lookback_days: i64) -> Collected {
    let mut out = Collected::default();
    let Some(key) = key.filter(|k| !k.is_empty()) else {
        return out;
    };

    let ending = chrono::Utc::now();
    let starting = ending - chrono::Duration::days(lookback_days.max(1));
    let range = [
        ("starting_at", starting.to_rfc3339()),
        ("ending_at", ending.to_rfc3339()),
    ];

    let mut errors: Vec<String> = Vec::new();

    // --- consommation ------------------------------------------------------
    let usage_params: Vec<(&str, String)> = range
        .iter()
        .cloned()
        .chain([
            ("bucket_width", "1d".to_string()),
            ("group_by[]", "model".to_string()),
            ("group_by[]", "service_tier".to_string()),
            ("limit", "31".to_string()),
        ])
        .collect();

    match anthropic_pages(
        &format!("{ANTHROPIC_BASE}/usage_report/messages"),
        &usage_params,
        key,
    ) {
        Err(e) => errors.push(format!("usage: {e}")),
        Ok(buckets) => {
            out.events.extend(parse_anthropic_buckets(&buckets));
        }
    }

    // --- coût facturé ------------------------------------------------------
    let cost_params: Vec<(&str, String)> = range
        .iter()
        .cloned()
        .chain([("limit", "31".to_string())])
        .collect();
    match anthropic_pages(&format!("{ANTHROPIC_BASE}/cost_report"), &cost_params, key) {
        Err(e) => errors.push(format!("cost: {e}")),
        Ok(buckets) => {
            out.cost = Some(parse_cost_buckets(&buckets));
        }
    }

    out.errors = errors;
    out.stats.events = out.events.len();
    out
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

pub fn collect_openai(key: Option<&str>, lookback_days: i64) -> Collected {
    let mut out = Collected::default();
    let Some(key) = key.filter(|k| !k.is_empty()) else {
        return out;
    };

    let end_time = now_ms() / 1000;
    let start_time = end_time - lookback_days.max(1) * 86_400;

    let a = agent();
    let mut page: Option<String> = None;
    let mut errors: Vec<String> = Vec::new();

    for _ in 0..MAX_PAGES {
        let mut req = a
            .get(&format!("{OPENAI_BASE}/usage/completions"))
            .set("Authorization", &format!("Bearer {key}"))
            .query("start_time", &start_time.to_string())
            .query("end_time", &end_time.to_string())
            .query("bucket_width", "1d")
            .query("group_by[]", "model")
            .query("limit", "31");
        if let Some(p) = &page {
            req = req.query("page", p);
        }

        let json = match fetch(req, "OpenAI", "api.adminKeyRequired.openai") {
            Ok(v) => v,
            Err(e) => {
                errors.push(e);
                break;
            }
        };

        if let Some(buckets) = json["data"].as_array() {
            out.events.extend(parse_openai_buckets(buckets));
        }

        match (json["has_more"].as_bool(), json["next_page"].as_str()) {
            (Some(true), Some(next)) => page = Some(next.to_string()),
            _ => break,
        }
    }

    out.errors = errors;
    out.stats.events = out.events.len();
    out
}

// ---------------------------------------------------------------------------
// Analyse des réponses
// ---------------------------------------------------------------------------
//
// Séparée de l'appel réseau : c'est la partie qui change quand une API évolue,
// et la seule qu'on puisse éprouver sans clé Admin ni connexion.

/// Convertit les seaux d'usage Anthropic en événements.
pub fn parse_anthropic_buckets(buckets: &[Value]) -> Vec<Event> {
    let empty = Vec::new();
    let mut out = Vec::new();
    for b in buckets {
        let ts = bucket_ts(b);
        for r in b["results"].as_array().unwrap_or(&empty) {
            let cc = &r["cache_creation"];
            let w5 = n(&cc["ephemeral_5m_input_tokens"]);
            let w1 = n(&cc["ephemeral_1h_input_tokens"]);
            let declared = w5 + w1;
            let raw_write = if declared != 0 {
                declared
            } else {
                n(&r["cache_creation_input_tokens"])
            };
            let (cache_write, cache_write5m, cache_write1h) =
                Tokens::split_cache_write(raw_write, w5, w1);

            // `uncached_input_tokens` quand l'API le donne : c'est la part
            // réellement facturée plein tarif. Retomber sur `input_tokens`,
            // qui inclut le cache, la compterait deux fois.
            let input = if r["uncached_input_tokens"].is_null() {
                n(&r["input_tokens"])
            } else {
                n(&r["uncached_input_tokens"])
            };
            let output = n(&r["output_tokens"]);
            let cache_read = n(&r["cache_read_input_tokens"]);
            let total = input + output + cache_read + cache_write;
            if total == 0 {
                continue;
            }

            out.push(Event {
                ts,
                source: ANTHROPIC.to_string(),
                model: r["model"].as_str().unwrap_or("unknown").to_string(),
                project: r["workspace_id"].as_str().map(str::to_string),
                session: None,
                tokens: Tokens {
                    input,
                    output,
                    cache_read,
                    cache_write,
                    cache_write5m,
                    cache_write1h,
                    thinking: 0,
                    total,
                },
                requests: n(&r["num_requests"]).max(1),
                compacted: None,
            });
        }
    }
    out
}

/// Convertit les seaux d'usage OpenAI en événements.
pub fn parse_openai_buckets(buckets: &[Value]) -> Vec<Event> {
    let empty = Vec::new();
    let mut out = Vec::new();
    for b in buckets {
        let ts = bucket_ts(b);
        for r in b["results"].as_array().unwrap_or(&empty) {
            let cache_read = n(&r["input_cached_tokens"]);
            // `input_tokens` inclut le cache : on isole la part réellement
            // facturée plein tarif, sans quoi elle serait comptée deux fois.
            let input = (n(&r["input_tokens"]) - cache_read).max(0);
            let output = n(&r["output_tokens"]);
            let total = input + output + cache_read;
            if total == 0 {
                continue;
            }
            out.push(Event {
                ts,
                source: OPENAI.to_string(),
                model: r["model"].as_str().unwrap_or("unknown").to_string(),
                project: r["project_id"].as_str().map(str::to_string),
                session: None,
                tokens: Tokens {
                    input,
                    output,
                    cache_read,
                    total,
                    ..Tokens::empty()
                },
                requests: n(&r["num_model_requests"]).max(1),
                compacted: None,
            });
        }
    }
    out
}

/// Agrège le rapport de coût de l'organisation.
pub fn parse_cost_buckets(buckets: &[Value]) -> CostReport {
    let empty = Vec::new();
    let mut report = CostReport::default();
    for b in buckets {
        let ts = bucket_ts(b);
        for r in b["results"].as_array().unwrap_or(&empty) {
            // Le montant arrive parfois en chaîne, parfois en nombre.
            let amount = r["amount"]
                .as_f64()
                .or_else(|| r["amount"].as_str().and_then(|s| s.parse().ok()));
            let Some(amount) = amount.filter(|a| a.is_finite()) else {
                continue;
            };
            report.total_usd += amount;
            *report.by_day.entry(crate::util::day_key(ts)).or_default() += amount;
        }
    }
    report
}
