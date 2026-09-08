//! Collecteur Claude Code : les fichiers `.jsonl` sous `~/.claude/projects`.
//!
//! Chaque message d'assistant y porte un bloc `usage` complet, ventilation du
//! cache par TTL comprise (`ephemeral_5m` / `ephemeral_1h`), ce qui permet une
//! tarification exacte plutôt qu'approchée.
//!
//! Deux pièges dans ce format, tous deux traités ici :
//!
//!  1. Un même message apparaît plusieurs fois — Claude Code réécrit la ligne
//!     au fil du streaming. Les doublons partagent `message.id`, et les
//!     compter deux fois doublerait purement et simplement la facture.
//!  2. Les entrées `quotaLimits`, émises sur 429, portent l'état réel des
//!     limites : type de fenêtre et instant de réinitialisation. C'est la
//!     seule source fiable sur le sujet, on la récupère au passage.

use super::{
    parse_ts, Cause, Collected, CollectorState, Event, FileCursor, Quota, Stats, DEDUP_WINDOW,
};
use crate::util::{now_ms, project_name, read_jsonl_from, walk_files, Tokens};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};

pub const SOURCE: &str = "claude-code";

pub fn root_dir(configured: Option<&str>) -> PathBuf {
    match configured {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => crate::util::home_dir().join(".claude").join("projects"),
    }
}

pub fn is_available(configured: Option<&str>) -> bool {
    root_dir(configured).is_dir()
}

/// Classe la CAUSE réelle d'un refus, à partir du texte du message.
pub fn rejection_cause(rec: &Value) -> Cause {
    let text = rec["message"]["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .map(|c| match c {
                    Value::String(s) => s.as_str(),
                    other => other["text"].as_str().unwrap_or(""),
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
        .to_lowercase();

    if ["spend limit", "spending limit", "credit balance", "out of credits"]
        .iter()
        .any(|p| text.contains(p))
    {
        return Cause::Spend;
    }
    if text.contains("weekly limit") {
        return Cause::Weekly;
    }
    if ["session limit", "usage limit", "rate limit"].iter().any(|p| text.contains(p)) {
        return Cause::Window;
    }
    Cause::Unknown
}

/// Convertit un bloc `usage` brut en structure de tokens canonique.
pub fn extract_tokens(usage: &Value) -> Tokens {
    let n = |v: &Value| v.as_i64().unwrap_or(0);

    let cc = &usage["cache_creation"];
    let w5 = n(&cc["ephemeral_5m_input_tokens"]);
    let w1 = n(&cc["ephemeral_1h_input_tokens"]);
    let input = n(&usage["input_tokens"]);
    let output = n(&usage["output_tokens"]);
    let cache_read = n(&usage["cache_read_input_tokens"]);

    // On préfère la ventilation par TTL quand elle est là ;
    // `cache_creation_input_tokens` sert de repli pour les versions de
    // journaux qui ne la fournissent pas.
    let declared = w5 + w1;
    let raw_total = if declared != 0 { declared } else { n(&usage["cache_creation_input_tokens"]) };
    let (cache_write, cache_write5m, cache_write1h) = Tokens::split_cache_write(raw_total, w5, w1);

    let thinking = n(&usage["output_tokens_details"]["thinking_tokens"]);

    Tokens {
        input,
        output,
        cache_read,
        cache_write,
        cache_write5m,
        cache_write1h,
        thinking,
        // `total` est ce que le fournisseur a facturé, pas une somme des
        // parties : les TTL sont déjà comptés dans `cache_write`.
        total: input + output + cache_read + cache_write,
    }
}

/// Scanne les journaux, en repartant de l'état d'indexation fourni.
pub fn collect(configured_dir: Option<&str>, state: &CollectorState) -> Collected {
    let dir = root_dir(configured_dir);
    let files = walk_files(&dir, &|p: &Path| {
        p.extension().and_then(|e| e.to_str()) == Some("jsonl")
    });

    let mut out = Collected {
        state: CollectorState { files: Default::default() },
        stats: Stats { files: files.len(), ..Default::default() },
        ..Default::default()
    };

    for file in &files {
        let key = file.to_string_lossy().to_string();
        let prev = state.files.get(&key).cloned().unwrap_or_default();

        let mut seen: HashSet<String> = prev.seen.iter().cloned().collect();
        let mut order: VecDeque<String> = prev.seen.iter().cloned().collect();

        let mut events = Vec::new();
        let mut quota = Vec::new();
        let mut skipped = 0usize;

        let res = read_jsonl_from(file, prev.offset, |rec| {
            // --- état des limites de débit ---------------------------------
            let limits = &rec["quotaLimits"];
            if let Some(resets_at) = limits["resetsAt"].as_f64() {
                quota.push(Quota {
                    source: SOURCE.to_string(),
                    ts: parse_ts(rec["timestamp"].as_str()).unwrap_or_else(now_ms),
                    kind: limits["rateLimitType"].as_str().unwrap_or("unknown").to_string(),
                    status: limits["status"].as_str().map(str::to_string),
                    resets_at: (resets_at * 1000.0) as i64,
                    using_overage: limits["isUsingOverage"].as_bool().unwrap_or(false),
                    cause: rejection_cause(rec),
                });
            }

            // --- consommation ----------------------------------------------
            let msg = &rec["message"];
            if msg["role"].as_str() != Some("assistant") || !msg["usage"].is_object() {
                return;
            }

            let dedup_key = msg["id"].as_str().or_else(|| rec["requestId"].as_str());
            if let Some(k) = dedup_key {
                if seen.contains(k) {
                    skipped += 1;
                    return;
                }
                seen.insert(k.to_string());
                order.push_back(k.to_string());
                if order.len() > DEDUP_WINDOW {
                    if let Some(old) = order.pop_front() {
                        seen.remove(&old);
                    }
                }
            }

            let tokens = extract_tokens(&msg["usage"]);
            if tokens.total == 0 {
                return;
            }

            events.push(Event {
                ts: parse_ts(rec["timestamp"].as_str()).unwrap_or_else(now_ms),
                source: SOURCE.to_string(),
                model: msg["model"].as_str().unwrap_or("unknown").to_string(),
                project: rec["cwd"].as_str().and_then(project_name),
                session: rec["sessionId"].as_str().map(str::to_string),
                tokens,
                requests: 1,
                compacted: None,
            });
        });

        let keep = order.len().saturating_sub(DEDUP_WINDOW);
        out.state.files.insert(
            key,
            FileCursor { offset: res.offset, seen: order.into_iter().skip(keep).collect() },
        );
        out.stats.skipped_duplicates += skipped;
        out.events.append(&mut events);
        out.quota.append(&mut quota);
    }

    out.stats.events = out.events.len();
    out
}
