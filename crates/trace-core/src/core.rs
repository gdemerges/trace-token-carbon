//! Façade du cœur : un seul point d'entrée pour l'application comme pour la
//! CLI. Rien ici ne connaît Tauri.

use crate::aggregate::{report, Options as ReportOptions, Report};
use crate::carbon::Options as CarbonOptions;
use crate::collectors::{collect_all, Event, Quota, SourceStatus};
use crate::provenance;
use crate::ratelimits::{apply_user_calibration, compute_gauges, Gauge};
use crate::store::{self, Config, Index};
use crate::util::now_ms;
use serde::Serialize;
use std::collections::HashMap;

const DAY_MS: i64 = 86_400_000;

/// Clé de secours contre le doublon.
///
/// Les collecteurs reprennent leur lecture à un offset et ne renvoient donc en
/// principe que du nouveau. Cette clé protège malgré tout du cas où un fichier
/// tronqué force un ré-scan complet depuis le début.
fn event_key(e: &Event) -> String {
    format!("{}|{}|{}|{}", e.source, e.ts, e.session.as_deref().unwrap_or(""), e.tokens.total)
}

fn quota_key(q: &Quota) -> String {
    format!("{}|{}|{}|{}", q.source, q.ts, q.kind, q.resets_at)
}

fn merge_records<T, F, K>(existing: Vec<T>, incoming: Vec<T>, key_of: F, ts_of: K) -> Vec<T>
where
    F: Fn(&T) -> String,
    K: Fn(&T) -> i64,
{
    if existing.is_empty() {
        return incoming;
    }
    if incoming.is_empty() {
        return existing;
    }
    let seen: std::collections::HashSet<String> = existing.iter().map(&key_of).collect();
    let added: Vec<T> = incoming.into_iter().filter(|r| !seen.contains(&key_of(r))).collect();
    if added.is_empty() {
        return existing;
    }
    let mut all = existing;
    all.extend(added);
    all.sort_by_key(&ts_of);
    all
}

/// L'état complet du cœur après un rafraîchissement.
pub struct State {
    pub config: Config,
    pub index: Index,
    pub events: Vec<Event>,
    pub quota: Vec<Quota>,
    pub sources: Vec<SourceStatus>,
    /// Ce que le relevé direct rapporte de lui-même au dernier passage.
    pub live_stats: Option<crate::collectors::anthropic_oauth::LiveStats>,
    /// Le coût facturé par le fournisseur : la seule vérification externe du
    /// chiffre estimé localement.
    pub cost: Option<crate::collectors::billing::CostReport>,
}

/// Rafraîchit toutes les sources et rend l'état à afficher.
pub fn refresh(config: Config, persist: bool) -> State {
    let idx = store::load_index(&config);
    let collected = collect_all(&config, &idx.collectors, &idx.live);

    // Deux régimes de fusion, parce que deux natures d'enregistrement.
    //
    // Un événement de requête s'AJOUTE : il décrit un fait passé, définitif.
    // Un agrégat journalier se REMPLACE : il décrit l'état d'une journée, et
    // celui du jour en cours grossit d'un relevé à l'autre. Les fusionner sous
    // la même règle faisait empiler les états successifs — à une minute de
    // cadence, la journée courante finissait comptée mille fois.
    let compacted_through = idx.compacted_through;
    let (previous_daily, previous_stream): (Vec<Event>, Vec<Event>) = idx
        .events
        .into_iter()
        .partition(|e| provenance::is_daily_grain(&e.source));
    let (incoming_daily, incoming_stream): (Vec<Event>, Vec<Event>) = collected
        .events
        .into_iter()
        .partition(|e| provenance::is_daily_grain(&e.source));

    // En deçà de la borne de compaction, l'index ne garde plus que des
    // agrégats horaires. Une relecture complète — provoquée par un
    // élargissement de la rétention ou un fichier tronqué — y ramènerait le
    // détail déjà replié, qui s'ajouterait à son propre agrégat.
    let incoming_stream: Vec<Event> =
        incoming_stream.into_iter().filter(|e| e.ts >= compacted_through).collect();

    let stream = merge_records(previous_stream, incoming_stream, event_key, |e| e.ts);
    let daily = provenance::merge_daily(previous_daily, incoming_daily);
    let mut events = stream;
    if !daily.is_empty() {
        events.extend(daily);
        events.sort_by_key(|e| e.ts);
    }

    // Les relevés en direct sont des INSTANTANÉS, pas de l'historique : on
    // n'en garde que le PLUS RÉCENT par fenêtre. Les empiler donnait soixante
    // entrées en dix minutes ; ne pas les garder du tout faisait perdre le
    // dernier chiffre connu au redémarrage, et la jauge retombait sur une
    // estimation fausse.
    let is_live = |q: &Quota| q.source == "anthropic-oauth";
    let (previous_live, previous_history): (Vec<Quota>, Vec<Quota>) =
        idx.quota.into_iter().partition(is_live);
    let (incoming_live, incoming_history): (Vec<Quota>, Vec<Quota>) =
        collected.quota.into_iter().partition(is_live);

    let mut quota = merge_records(previous_history, incoming_history, quota_key, |q| q.ts);
    let mut newest_live: HashMap<String, Quota> = HashMap::new();
    for q in previous_live.into_iter().chain(incoming_live) {
        match newest_live.get(&q.kind) {
            Some(cur) if cur.ts >= q.ts => {}
            _ => {
                newest_live.insert(q.kind.clone(), q);
            }
        }
    }
    let mut live: Vec<Quota> = newest_live.into_values().collect();
    // L'ordre d'une table de hachage n'est pas stable ; les jauges le lisent.
    live.sort_by(|a, b| a.kind.cmp(&b.kind));
    quota.extend(live);

    let next = Index {
        version: store::INDEX_VERSION,
        collectors: collected.state.clone(),
        events,
        quota,
        compacted_through,
        live: collected.live.clone(),
        ..Index::default()
    };

    // `save_index` applique la rétention. On garde l'index RETENU, pas celui
    // d'avant élagage : sinon la vue en mémoire et le fichier divergent, et le
    // nombre d'événements changerait tout seul au redémarrage suivant.
    let mut index = if persist { store::save_index(next, &config) } else { next };
    index.collectors = collected.state;

    State {
        events: index.events.clone(),
        quota: index.quota.clone(),
        sources: collected.sources,
        live_stats: collected.live_stats,
        cost: collected.cost,
        index,
        config,
    }
}

#[derive(Debug, Clone, Default)]
pub struct SnapshotOptions {
    pub days: Option<i64>,
    /// Remonte aussi loin que les données le permettent.
    pub all: bool,
    pub to: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Horizon {
    pub from: Option<i64>,
    pub by_source: HashMap<String, i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRange {
    pub from: i64,
    pub to: i64,
    pub days: i64,
    pub all: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub generated_at: i64,
    pub range: SnapshotRange,
    pub data_horizon: Horizon,
    pub live_status: Option<serde_json::Value>,
    pub report: Report,
    pub gauges: Vec<Gauge>,
    pub sources: Vec<SourceStatus>,
    pub config: Config,
    pub has_keys: HashMap<String, bool>,
    /// L'annexe méthodologique — la table des facteurs et leurs citations.
    /// Reste à porter : c'est de la donnée et de la mise en forme, aucun
    /// chiffre affiché n'en dépend.
    pub methodology: Option<serde_json::Value>,
    pub stale_error: Option<String>,
    /// Ce que les sources rapportent au-delà des tokens — pour l'instant, le
    /// coût facturé par Anthropic.
    pub extra: serde_json::Value,
}

/// Construit l'instantané destiné à l'affichage.
pub fn snapshot(state: &State, opts: &SnapshotOptions) -> Snapshot {
    let config = &state.config;
    let to = opts.to.unwrap_or_else(now_ms);

    // Horizon réel : jusqu'où les sources permettent de remonter. Sans cette
    // information, une période d'un an paraît vide « à cause de TRACE », alors
    // que c'est Claude Code qui purge ses sessions au bout de deux mois.
    let mut horizon = Horizon { from: None, by_source: HashMap::new() };
    for e in &state.events {
        horizon.from = Some(horizon.from.map_or(e.ts, |f: i64| f.min(e.ts)));
        horizon
            .by_source
            .entry(e.source.clone())
            .and_modify(|cur| *cur = (*cur).min(e.ts))
            .or_insert(e.ts);
    }

    let days = if opts.all {
        None
    } else {
        Some(opts.days.unwrap_or(config.default_range_days))
    };
    let from = match days {
        Some(d) => to - d * DAY_MS,
        None => horizon.from.unwrap_or(to - 30 * DAY_MS),
    };

    let report_opts = ReportOptions {
        from: Some(from),
        to: Some(to),
        carbon: CarbonOptions {
            grid_key: Some(config.carbon.grid_key.clone()),
            pue: config.carbon.pue,
            ..CarbonOptions::default()
        },
        model_overrides: Some(config.model_overrides.clone()),
    };

    let mut rep = report(&state.events, &report_opts);
    let mut gauges = compute_gauges(&state.events, &state.quota, config, to);

    // La jauge en direct porte l'échéance du prochain relevé.
    if let Some(next) = state.live_stats.as_ref().map(|l| l.next_attempt_in).filter(|n| *n > 0) {
        for g in &mut gauges {
            if matches!(g.limit_source.as_deref(), Some("live") | Some("live-stale")) {
                g.next_live_in = Some(next);
            }
        }
    }

    // Une période de comparaison presque vide produit des variations absurdes
    // (+15 000 %). On la signale plutôt que de l'afficher telle quelle.
    let prev_total = rep.trend.previous.tokens.total as f64;
    rep.trend.significant =
        Some(prev_total > 1000.0_f64.max(rep.totals.tokens.total as f64 * 0.02));

    // Les collecteurs reprennent leur lecture à un offset : le nombre
    // d'événements qu'ils viennent de renvoyer est un DELTA, pas un total.
    // L'afficher tel quel donnerait « Claude Code — 4 » sur une base de 6 000.
    let mut indexed: HashMap<&str, usize> = HashMap::new();
    let mut in_range: HashMap<&str, usize> = HashMap::new();
    for e in &state.events {
        *indexed.entry(e.source.as_str()).or_default() += 1;
        if e.ts >= from && e.ts <= to {
            *in_range.entry(e.source.as_str()).or_default() += 1;
        }
    }
    let sources: Vec<SourceStatus> = state
        .sources
        .iter()
        .map(|s| {
            let mut s = s.clone();
            s.events = indexed.get(s.id.as_str()).copied().unwrap_or(0);
            s
        })
        .collect();

    // Jamais de clé vers l'interface : elle affiche seulement qu'il y en a une.
    let mut safe_config = config.clone();
    let has_keys = HashMap::from([
        ("anthropic".to_string(), safe_config.anthropic_admin_key.is_some()),
        ("openai".to_string(), safe_config.openai_admin_key.is_some()),
    ]);
    safe_config.anthropic_admin_key = None;
    safe_config.openai_admin_key = None;

    Snapshot {
        generated_at: now_ms(),
        range: SnapshotRange {
            from,
            to,
            days: days.unwrap_or_else(|| ((to - from) as f64 / DAY_MS as f64).round() as i64),
            all: opts.all,
        },
        data_horizon: horizon,
        live_status: live_status(state),
        report: rep,
        gauges,
        sources,
        config: safe_config,
        has_keys,
        methodology: None,
        stale_error: None,
        extra: match &state.cost {
            Some(c) => serde_json::json!({ "anthropic-api": { "cost": c } }),
            None => serde_json::json!({}),
        },
    }
}

/// L'état du relevé direct, tel que l'interface doit le présenter.
///
/// Une source en attente après un échec n'est PAS « ok » : la première version
/// ne regardait que l'erreur, or un report hérité d'un redémarrage n'a pas de
/// motif. L'interface n'affichait donc rien et l'utilisateur voyait un chiffre
/// figé sans explication.
///
/// La cadence, elle, se dit sur la jauge elle-même et non dans un bandeau
/// d'alerte : c'est le fonctionnement nominal, pas un incident.
fn live_status(state: &State) -> Option<serde_json::Value> {
    let l = state.live_stats.as_ref()?;
    let waiting = l.next_attempt_in > 0 && l.next_attempt_reason == Some("backoff");
    let pacing = l.next_attempt_in > 0 && l.next_attempt_reason == Some("cadence");
    let error = l.errors.first().cloned().or_else(|| {
        waiting.then(|| crate::i18n::t("oauth.suspended"))
    });
    Some(serde_json::json!({
        "ok": l.errors.is_empty() && !waiting,
        "waiting": waiting,
        "pacing": pacing,
        "error": error,
        "ageMs": l.age_ms,
        "nextAttemptIn": l.next_attempt_in,
    }))
}

/// Recale une jauge sur un pourcentage relevé par l'utilisateur et enregistre
/// la configuration. C'est la seule voie exacte côté Anthropic : le vrai
/// pourcentage n'existe nulle part en local.
pub fn calibrate(state: &State, gauge_id: &str, percent: f64) -> Result<Config, String> {
    let updated = apply_user_calibration(
        &store::load_config(),
        &state.events,
        &state.quota,
        gauge_id,
        percent,
        now_ms(),
    )?;
    store::save_config(&updated).map_err(|e| e.to_string())?;
    Ok(updated)
}
