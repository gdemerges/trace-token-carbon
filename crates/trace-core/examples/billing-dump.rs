//! Vidage de l'analyse des rapports de facturation, sur les mêmes réponses que
//! celles servies au collecteur JS. Non distribué.

use serde_json::json;
use trace_core::collectors::billing::{
    parse_anthropic_buckets, parse_cost_buckets, parse_openai_buckets,
};

fn main() {
    let usage = vec![json!({ "starting_at": "2026-09-01T00:00:00Z", "results": [
        { "model": "claude-opus-5", "workspace_id": "ws_1", "uncached_input_tokens": 1000, "input_tokens": 51000, "output_tokens": 200, "cache_read_input_tokens": 50000, "num_requests": 7 },
        { "model": "claude-sonnet-5", "input_tokens": 900, "output_tokens": 100 },
        { "model": "claude-opus-5", "uncached_input_tokens": 0, "output_tokens": 0, "cache_creation": { "ephemeral_5m_input_tokens": 300, "ephemeral_1h_input_tokens": 700 } },
        { "model": "claude-opus-5", "input_tokens": 0, "output_tokens": 0 }
    ]})];
    for e in parse_anthropic_buckets(&usage) {
        let t = e.tokens;
        println!(
            "A\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            e.model,
            e.project.as_deref().unwrap_or(""),
            t.input,
            t.output,
            t.cache_read,
            t.cache_write,
            t.cache_write5m,
            t.cache_write1h,
            t.total,
            e.requests
        );
    }

    let cost = vec![
        json!({ "starting_at": "2026-09-01T12:00:00Z", "results": [{ "amount": 1.25 }, { "amount": "2.75" }] }),
        json!({ "starting_at": "2026-09-02T12:00:00Z", "results": [{ "amount": 4.0 }] }),
    ];
    let r = parse_cost_buckets(&cost);
    println!("COST\t{:.6}\t{}", r.total_usd, r.by_day.len());

    let oai = vec![json!({ "start_time": 1788220800, "results": [
        { "model": "gpt-5", "project_id": "proj_1", "input_tokens": 12000, "input_cached_tokens": 10000, "output_tokens": 500, "num_model_requests": 3 },
        { "model": "gpt-5", "input_tokens": 100, "input_cached_tokens": 500, "output_tokens": 10 }
    ]})];
    for e in parse_openai_buckets(&oai) {
        let t = e.tokens;
        println!(
            "O\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            e.model,
            e.project.as_deref().unwrap_or(""),
            t.input,
            t.output,
            t.cache_read,
            t.total,
            e.requests
        );
    }
}
