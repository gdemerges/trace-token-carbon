//! Collecteur Codex CLI / Codex Desktop : les « rollouts » sous
//! `~/.codex/sessions` et `~/.codex/archived_sessions`.
//!
//! Piège central du format : chaque événement `token_count` porte DEUX
//! compteurs, `total_token_usage` (cumulé depuis le début de la session) et
//! `last_token_usage` (le tour qui vient de s'écouler). Sommer le premier
//! multiplierait la consommation par le nombre de tours. On n'utilise donc que
//! le second.
//!
//! Bon côté : ces événements embarquent aussi `rate_limits`, avec un
//! pourcentage d'utilisation déjà calculé côté serveur et la taille de la
//! fenêtre — bien plus fiable que tout ce qu'on pourrait reconstruire.

use super::{parse_ts, Cause, Collected, CollectorState, Event, FileCursor, Quota, Stats};
use crate::util::{now_ms, project_name, read_jsonl_from, walk_files, Tokens};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const SOURCE: &str = "codex-cli";

pub fn root_dirs(configured: Option<&str>) -> Vec<PathBuf> {
    let base = match configured {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => crate::util::home_dir().join(".codex"),
    };
    vec![base.join("sessions"), base.join("archived_sessions")]
}

pub fn is_available(configured: Option<&str>) -> bool {
    root_dirs(configured).iter().any(|d| d.is_dir())
}

fn is_rollout(p: &Path) -> bool {
    let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    name.starts_with("rollout-") && name.ends_with(".jsonl")
}

pub fn collect(configured_dir: Option<&str>, state: &CollectorState) -> Collected {
    let mut files: Vec<PathBuf> = Vec::new();
    for dir in root_dirs(configured_dir) {
        files.extend(walk_files(&dir, &is_rollout));
    }

    let mut out = Collected {
        stats: Stats {
            files: files.len(),
            ..Default::default()
        },
        ..Default::default()
    };

    for file in &files {
        let key = file.to_string_lossy().to_string();
        let prev = state.files.get(&key).cloned().unwrap_or_default();

        let mut model = prev.model.unwrap_or_else(|| "codex".to_string());
        let mut project = prev.project;
        let mut session = prev.session;
        let mut events = Vec::new();
        let mut quota = Vec::new();

        let res = read_jsonl_from(file, prev.offset, |rec| {
            let p = &rec["payload"];
            if p.is_null() {
                return;
            }

            // Le modèle et le répertoire de travail arrivent en tête de
            // fichier ; on les mémorise pour les reprises incrémentales.
            if rec["type"] == "session_meta" || p["type"] == "session_meta" {
                if let Some(m) = p["model"].as_str() {
                    model = m.to_string();
                }
                if let Some(c) = p["cwd"].as_str() {
                    project = project_name(c);
                }
                if let Some(s) = p["session_id"].as_str() {
                    session = Some(s.to_string());
                }
                return;
            }
            if p["type"] == "turn_context" {
                if let Some(m) = p["model"].as_str() {
                    model = m.to_string();
                }
                return;
            }
            if p["type"] != "token_count" || !p["info"].is_object() {
                return;
            }

            let ts = parse_ts(rec["timestamp"].as_str()).unwrap_or_else(now_ms);

            // --- limites de débit, déjà calculées par le serveur -------------
            let rl = &p["rate_limits"];
            if rl.is_object() {
                for key in ["primary", "secondary"] {
                    let w = &rl[key];
                    let Some(used_percent) = w["used_percent"].as_f64() else {
                        continue;
                    };
                    let window_minutes = w["window_minutes"].as_f64();
                    quota.push(Quota {
                        source: SOURCE.to_string(),
                        ts,
                        kind: match window_minutes {
                            Some(m) => format!("{}min", m as i64),
                            None => key.to_string(),
                        },
                        status: Some(
                            if rl["rate_limit_reached_type"].is_null() {
                                "ok"
                            } else {
                                "rejected"
                            }
                            .to_string(),
                        ),
                        resets_at: w["resets_at"]
                            .as_f64()
                            .map(|s| (s * 1000.0) as i64)
                            .unwrap_or(0),
                        using_overage: false,
                        cause: Cause::Window,
                        used_percent: Some(used_percent),
                        window_minutes,
                        plan: rl["plan_type"].as_str().map(str::to_string),
                    });
                }
            }

            // --- consommation du tour ----------------------------------------
            let u = &p["info"]["last_token_usage"];
            if !u.is_object() {
                return;
            }
            let n = |v: &Value| v.as_i64().unwrap_or(0);
            let cache_read = n(&u["cached_input_tokens"]);
            let cache_write = n(&u["cache_write_input_tokens"]);
            // `input_tokens` inclut déjà les tokens servis par le cache : on
            // les retranche pour ne pas les facturer deux fois, une fois au
            // tarif plein et une fois au tarif cache.
            let input = (n(&u["input_tokens"]) - cache_read - cache_write).max(0);
            let output = n(&u["output_tokens"]);
            let total = input + output + cache_read + cache_write;
            if total == 0 {
                return;
            }

            events.push(Event {
                ts,
                source: SOURCE.to_string(),
                model: model.clone(),
                project: project.clone(),
                session: session.clone(),
                tokens: Tokens {
                    input,
                    output,
                    cache_read,
                    cache_write,
                    // Codex ne ventile pas ses TTL : tout part au 5 minutes,
                    // le plus courant, plutôt que d'être perdu.
                    cache_write5m: cache_write,
                    cache_write1h: 0,
                    thinking: n(&u["reasoning_output_tokens"]),
                    total,
                },
                requests: 1,
                compacted: None,
            });
        });

        out.state.files.insert(
            key,
            FileCursor {
                offset: res.offset,
                seen: Vec::new(),
                model: Some(model),
                project,
                session,
            },
        );
        out.events.append(&mut events);
        out.quota.append(&mut quota);
    }

    out.stats.events = out.events.len();
    out
}
