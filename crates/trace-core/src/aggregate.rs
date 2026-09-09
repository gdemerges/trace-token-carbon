//! Transforme une liste brute d'événements en tous les agrégats dont
//! l'interface a besoin.
//!
//! Principe directeur, et il commande toute la structure du module : le coût
//! et le carbone sont calculés PAR MODÈLE puis sommés, jamais sur un total de
//! tokens agrégé. Additionner d'abord les tokens de modèles différents puis
//! appliquer un tarif moyen donnerait un résultat faux dès que l'usage est
//! réparti sur plusieurs modèles — c'est-à-dire toujours.

use crate::carbon::{self, Options as CarbonOptions, Pair};
use crate::collectors::Event;
use crate::models::{resolve_model, ModelOverride};
use crate::pricing::{cost, cost_without_cache};
use crate::provenance;
use crate::util::{day_key, now_ms, Tokens};
use chrono::{Datelike, Local, TimeZone, Timelike};
use serde::Serialize;
use std::collections::HashMap;

const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, Default)]
pub struct Options {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub carbon: CarbonOptions,
    pub model_overrides: Option<HashMap<String, ModelOverride>>,
}

/// La ventilation d'un modèle à l'intérieur d'un groupe, telle qu'elle part
/// vers l'interface.
///
/// Projection explicite, et non la fiche complète : le bucket de travail porte
/// le modèle entier et le détail carbone dont il a besoin pour chiffrer. Les
/// recopier les faisait voyager en double — la même fiche répétée pour chaque
/// couple (projet, modèle), soit 42 Ko de ventilation dans un instantané de
/// 108, transmis toutes les minutes, que rien ne lisait.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSlice {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub tokens: Tokens,
    pub requests: i64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub cost_unknown: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub key: String,
    pub tokens: Tokens,
    pub requests: i64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub cost_unknown: bool,
    #[serde(rename = "costWithoutCacheUSD")]
    pub cost_without_cache_usd: f64,
    pub carbon: carbon::Total,
    pub models: Vec<ModelSlice>,
}

/// Agrège des événements par une clé arbitraire, en conservant la ventilation
/// par modèle à l'intérieur de chaque groupe pour pouvoir chiffrer.
fn group_by<F>(events: &[Event], key_of: F, opts: &Options) -> Vec<Group>
where
    F: Fn(&Event) -> Option<String>,
{
    struct Bucket {
        tokens: Tokens,
        requests: i64,
        models: HashMap<String, (Tokens, i64)>,
        /// Ordre de première apparition : une table de hachage ne garantit pas
        /// l'ordre, et deux passes sur la même donnée doivent produire le même
        /// instantané.
        order: Vec<String>,
    }

    let mut groups: HashMap<String, Bucket> = HashMap::new();
    let mut group_order: Vec<String> = Vec::new();

    for e in events {
        let Some(key) = key_of(e) else { continue };
        let g = groups.entry(key.clone()).or_insert_with(|| {
            group_order.push(key.clone());
            Bucket {
                tokens: Tokens::empty(),
                requests: 0,
                models: HashMap::new(),
                order: Vec::new(),
            }
        });
        g.tokens.add(&e.tokens);
        g.requests += if e.requests != 0 { e.requests } else { 1 };

        let m = g.models.entry(e.model.clone()).or_insert_with(|| {
            g.order.push(e.model.clone());
            (Tokens::empty(), 0)
        });
        m.0.add(&e.tokens);
        m.1 += if e.requests != 0 { e.requests } else { 1 };
    }

    group_order
        .into_iter()
        .map(|key| {
            let b = groups
                .remove(&key)
                .expect("clé issue de l'ordre d'insertion");

            // Chiffrage : par modèle, puis somme. Jamais l'inverse.
            let mut slices: Vec<(ModelSlice, carbon::Estimate, f64)> = b
                .order
                .iter()
                .map(|model_id| {
                    let (tokens, requests) = b.models[model_id];
                    let model = resolve_model(model_id, opts.model_overrides.as_ref());
                    let c = cost(&tokens, &model);
                    let est = carbon::estimate(&tokens, &model, &opts.carbon);
                    (
                        ModelSlice {
                            id: model.id.clone(),
                            label: model.label.clone(),
                            provider: model.provider.clone(),
                            tokens,
                            requests,
                            cost_usd: c.unwrap_or(0.0),
                            cost_unknown: c.is_none(),
                        },
                        est,
                        cost_without_cache(&tokens, &model).unwrap_or(0.0),
                    )
                })
                .collect();

            let cost_usd = slices.iter().map(|(m, _, _)| m.cost_usd).sum();
            let cost_unknown = slices.iter().any(|(m, _, _)| m.cost_unknown);
            let cost_without_cache_usd = slices.iter().map(|(_, _, w)| w).sum();
            let carbon_total = carbon::sum(slices.iter().map(|(_, e, _)| e));

            slices.sort_by_key(|s| std::cmp::Reverse(s.0.tokens.total));

            Group {
                key,
                tokens: b.tokens,
                requests: b.requests,
                cost_usd,
                cost_unknown,
                cost_without_cache_usd,
                carbon: carbon_total,
                models: slices.into_iter().map(|(m, _, _)| m).collect(),
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayPoint {
    pub date: String,
    pub ts: i64,
    pub tokens: Tokens,
    pub requests: i64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    #[serde(rename = "gramsCO2e")]
    pub grams_co2e: f64,
    pub models: Vec<DayModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayModel {
    pub id: String,
    pub label: String,
    pub total: i64,
}

/// Série journalière continue : les jours sans usage valent zéro, pas un trou.
///
/// Un graphe qui saute les jours vides ment sur le rythme : il resserre les
/// creux et fait passer une semaine de pause pour une journée ordinaire.
fn daily_series(events: &[Event], from: i64, to: i64, opts: &Options) -> Vec<DayPoint> {
    let by_day: HashMap<String, Group> = group_by(events, |e| Some(day_key(e.ts)), opts)
        .into_iter()
        .map(|g| (g.key.clone(), g))
        .collect();

    let start = Local
        .timestamp_millis_opt(from)
        .single()
        .map(|d| d.date_naive())
        .unwrap_or_else(|| Local::now().date_naive());
    let end = Local
        .timestamp_millis_opt(to)
        .single()
        .map(|d| d.date_naive())
        .unwrap_or_else(|| Local::now().date_naive());

    let mut series = Vec::new();
    let mut cursor = start;
    while cursor <= end {
        // Minuit LOCAL : la clé de jour l'est aussi, et un décalage d'une
        // heure ferait glisser tout un jour de série.
        let ts = cursor
            .and_hms_opt(0, 0, 0)
            .and_then(|dt| Local.from_local_datetime(&dt).single())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        let key = format!(
            "{:04}-{:02}-{:02}",
            cursor.year(),
            cursor.month(),
            cursor.day()
        );
        let g = by_day.get(&key);
        series.push(DayPoint {
            date: key,
            ts,
            tokens: g.map(|g| g.tokens).unwrap_or_default(),
            requests: g.map(|g| g.requests).unwrap_or(0),
            cost_usd: g.map(|g| g.cost_usd).unwrap_or(0.0),
            grams_co2e: g.map(|g| g.carbon.grams_co2e.mid).unwrap_or(0.0),
            models: g
                .map(|g| {
                    g.models
                        .iter()
                        .map(|m| DayModel {
                            id: m.id.clone(),
                            label: m.label.clone(),
                            total: m.tokens.total,
                        })
                        .collect()
                })
                .unwrap_or_default(),
        });
        cursor = cursor.succ_opt().unwrap_or(cursor);
        if cursor == end && series.len() > 4000 {
            break; // garde-fou : une plage aberrante ne doit pas boucler sans fin
        }
    }
    series
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourPoint {
    pub hour: u32,
    pub tokens: i64,
    pub requests: i64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    #[serde(rename = "gramsCO2e")]
    pub grams_co2e: f64,
}

/// Répartition par heure locale — elle révèle les rythmes de travail.
///
/// Passe par `group_by` comme la série journalière, et non par une simple
/// somme de tokens : une heure où l'on a mélangé Opus et Sonnet n'a pas de
/// tarif moyen qui veuille dire quelque chose.
fn hour_histogram(events: &[Event], opts: &Options) -> Vec<HourPoint> {
    let by_hour: HashMap<String, Group> = group_by(
        events,
        |e| {
            Local
                .timestamp_millis_opt(e.ts)
                .single()
                .map(|d| d.hour().to_string())
        },
        opts,
    )
    .into_iter()
    .map(|g| (g.key.clone(), g))
    .collect();

    (0..24)
        .map(|hour| {
            let g = by_hour.get(&hour.to_string());
            HourPoint {
                hour,
                tokens: g.map(|g| g.tokens.total).unwrap_or(0),
                requests: g.map(|g| g.requests).unwrap_or(0),
                cost_usd: g.map(|g| g.cost_usd).unwrap_or(0.0),
                grams_co2e: g.map(|g| g.carbon.grams_co2e.mid).unwrap_or(0.0),
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub tokens: Tokens,
    pub requests: i64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub cost_unknown: bool,
    #[serde(rename = "costWithoutCacheUSD")]
    pub cost_without_cache_usd: f64,
    pub carbon: carbon::Total,
    pub equivalents: Vec<carbon::EquivalentAmount>,
    /// Un total carbone unique n'est pas défendable : il repose sur une
    /// hypothèse de localisation et sur des tailles de modèles non publiées.
    /// On livre donc avec le total ce qui permet de le contester.
    pub carbon_sensitivity: Vec<carbon::GridRow>,
    pub carbon_uncertainty: Vec<carbon::Lever>,
    #[serde(rename = "cacheSavingsUSD")]
    pub cache_savings_usd: f64,
    pub cache_hit_ratio: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Previous {
    pub tokens: Tokens,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub carbon: carbon::Total,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trend {
    pub tokens: Option<f64>,
    pub cost: Option<f64>,
    pub carbon: Option<f64>,
    pub previous: Previous,
    /// Posé plus haut dans la chaîne : une période de comparaison presque vide
    /// produit des variations absurdes qu'il vaut mieux signaler qu'afficher.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub significant: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub range: Range,
    pub totals: Totals,
    pub trend: Trend,
    pub by_model: Vec<Group>,
    pub by_project: Vec<Group>,
    pub daily: Vec<DayPoint>,
    pub hours: Vec<HourPoint>,
    pub event_count: usize,
    pub reconciliation: Vec<provenance::FamilyReconciliation>,
    pub billed_days_dropped: usize,
}

/// Combien d'événements au maximum peuvent tenir dans une série journalière
/// avant qu'on soupçonne une plage aberrante.
const PROJECT_ROWS: usize = 10;

fn pct_change(cur: f64, prev: f64) -> Option<f64> {
    if prev > 0.0 {
        Some(((cur - prev) / prev) * 100.0)
    } else {
        None
    }
}

/// Rapport complet sur une période.
pub fn report(events: &[Event], opts: &Options) -> Report {
    let to = opts.to.unwrap_or_else(now_ms);
    let from = opts.from.unwrap_or(to - 30 * DAY_MS);

    // Le chiffre facturé et la mesure locale décrivent les MÊMES requêtes :
    // les sommer doublait le total dès qu'une clé Admin était renseignée. On
    // écarte le doublon avant toute agrégation, et sur l'historique COMPLET
    // plutôt que sur la période affichée — sinon la même journée serait
    // retenue ou écartée selon le sélecteur de période, et le total bougerait
    // sans raison visible.
    let (measured, billed_days_dropped) = provenance::dedupe_families(events);
    let in_range: Vec<Event> = measured
        .iter()
        .filter(|e| e.ts >= from && e.ts <= to)
        .cloned()
        .collect();

    let mut by_model = group_by(&in_range, |e| Some(e.model.clone()), opts);
    by_model.sort_by_key(|g| std::cmp::Reverse(g.tokens.total));

    let mut by_project = group_by(
        &in_range,
        |e| {
            Some(
                e.project
                    .clone()
                    .unwrap_or_else(|| "sans projet".to_string()),
            )
        },
        opts,
    );
    by_project.sort_by_key(|g| std::cmp::Reverse(g.tokens.total));

    let mut tokens = Tokens::empty();
    let mut requests = 0;
    let mut cost_usd = 0.0;
    let mut cost_without_cache_usd = 0.0;
    let mut cost_unknown = false;
    for g in &by_model {
        tokens.add(&g.tokens);
        requests += g.requests;
        cost_usd += g.cost_usd;
        cost_without_cache_usd += g.cost_without_cache_usd;
        cost_unknown = cost_unknown || g.cost_unknown;
    }

    let carbon_total = {
        // Les groupes portent déjà leur total : on les additionne bornes à
        // bornes plutôt que de tout réestimer.
        let mut acc = carbon::Total::default();
        for g in &by_model {
            acc.grams_co2e.min += g.carbon.grams_co2e.min;
            acc.grams_co2e.max += g.carbon.grams_co2e.max;
            acc.grams_co2e.mid += g.carbon.grams_co2e.mid;
            acc.energy_wh.min += g.carbon.energy_wh.min;
            acc.energy_wh.max += g.carbon.energy_wh.max;
            acc.energy_wh.mid += g.carbon.energy_wh.mid;
            acc.water_l.min += g.carbon.water_l.min;
            acc.water_l.max += g.carbon.water_l.max;
            acc.water_l.mid += g.carbon.water_l.mid;
            acc.usage_g += g.carbon.usage_g;
            acc.embodied_g += g.carbon.embodied_g;
        }
        acc
    };

    // La clé d'un groupe `by_model` EST l'identifiant du modèle : on le résout
    // ici plutôt que de faire voyager la fiche dans chaque bucket.
    let resolved: Vec<_> = by_model
        .iter()
        .filter(|g| !g.models.is_empty() && g.tokens.total > 0)
        .map(|g| {
            (
                g.tokens,
                resolve_model(&g.key, opts.model_overrides.as_ref()),
            )
        })
        .collect();
    let pairs: Vec<Pair> = resolved
        .iter()
        .map(|(tokens, model)| Pair {
            tokens: *tokens,
            model,
        })
        .collect();

    let cache_denominator = tokens.cache_read + tokens.input + tokens.cache_write;
    let totals = Totals {
        equivalents: carbon::equivalents(carbon_total.grams_co2e.mid),
        carbon_sensitivity: if pairs.is_empty() {
            vec![]
        } else {
            carbon::grid_sensitivity(&pairs, &opts.carbon)
        },
        carbon_uncertainty: if pairs.is_empty() {
            vec![]
        } else {
            carbon::uncertainty(&pairs, &opts.carbon)
        },
        cache_savings_usd: (cost_without_cache_usd - cost_usd).max(0.0),
        cache_hit_ratio: if cache_denominator > 0 {
            tokens.cache_read as f64 / cache_denominator as f64
        } else {
            0.0
        },
        carbon: carbon_total,
        tokens,
        requests,
        cost_usd,
        cost_unknown,
        cost_without_cache_usd,
    };

    // Période précédente de même durée, pour afficher une tendance.
    let span = to - from;
    let prev_events: Vec<Event> = measured
        .iter()
        .filter(|e| e.ts >= from - span && e.ts < from)
        .cloned()
        .collect();
    let prev_by_model = group_by(&prev_events, |e| Some(e.model.clone()), opts);
    let mut prev_tokens = Tokens::empty();
    let mut prev_cost = 0.0;
    for g in &prev_by_model {
        prev_tokens.add(&g.tokens);
        prev_cost += g.cost_usd;
    }
    let prev_carbon = {
        let mut acc = carbon::Total::default();
        for g in &prev_by_model {
            acc.grams_co2e.min += g.carbon.grams_co2e.min;
            acc.grams_co2e.max += g.carbon.grams_co2e.max;
            acc.grams_co2e.mid += g.carbon.grams_co2e.mid;
            acc.energy_wh.mid += g.carbon.energy_wh.mid;
        }
        acc
    };

    by_project.truncate(PROJECT_ROWS);

    Report {
        range: Range { from, to },
        trend: Trend {
            tokens: pct_change(totals.tokens.total as f64, prev_tokens.total as f64),
            cost: pct_change(totals.cost_usd, prev_cost),
            carbon: pct_change(totals.carbon.grams_co2e.mid, prev_carbon.grams_co2e.mid),
            previous: Previous {
                tokens: prev_tokens,
                cost_usd: prev_cost,
                carbon: prev_carbon,
            },
            significant: None,
        },
        daily: daily_series(&in_range, from, to, opts),
        hours: hour_histogram(&in_range, opts),
        event_count: in_range.len(),
        // La réconciliation se construit sur les événements BRUTS : son objet
        // est précisément l'écart entre les deux vues qu'on vient de départager.
        reconciliation: provenance::reconciliation(events, from, to),
        billed_days_dropped,
        totals,
        by_model,
        by_project,
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Lignes d'export, en format LONG : une ligne par (jour, source, modèle,
/// projet), toutes colonnes renseignées.
///
/// La première version mélangeait deux tables dans un même fichier — des
/// lignes journalières dont huit colonnes sur treize restaient vides, suivies
/// de lignes « TOTAL » par modèle. Illisible par un tableur, inexploitable en
/// tableau croisé. Un format long se pivote, se filtre et se somme sans
/// retraitement.
pub fn export_rows(events: &[Event], opts: &Options) -> Vec<Vec<String>> {
    let to = opts.to.unwrap_or_else(now_ms);
    let from = opts.from.unwrap_or(to - 30 * DAY_MS);

    // Même départage que le rapport : un export qui compterait deux fois les
    // mêmes requêtes serait pire qu'un affichage faux, puisqu'il survit à
    // l'application et part dans un tableur.
    let (measured, _) = provenance::dedupe_families(events);
    let in_range: Vec<Event> = measured
        .into_iter()
        .filter(|e| e.ts >= from && e.ts <= to)
        .collect();

    let groups = group_by(
        &in_range,
        |e| {
            Some(format!(
                "{}\u{0}{}\u{0}{}\u{0}{}",
                day_key(e.ts),
                e.source,
                e.model,
                e.project.as_deref().unwrap_or("")
            ))
        },
        opts,
    );

    let header: Vec<String> = [
        "date",
        "source",
        "modele",
        "fournisseur",
        "projet",
        "requetes",
        "tokens_entree",
        "tokens_sortie",
        "cache_ecrit",
        "cache_lu",
        "tokens_total",
        "cout_usd",
        "cout_sans_cache_usd",
        "gco2e_min",
        "gco2e_median",
        "gco2e_max",
        "energie_wh",
        "eau_l",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    let mut body: Vec<Vec<String>> = groups
        .iter()
        .map(|g| {
            let parts: Vec<&str> = g.key.split('\u{0}').collect();
            let m = g.models.first();
            vec![
                parts.first().unwrap_or(&"").to_string(),
                parts.get(1).unwrap_or(&"").to_string(),
                m.map(|m| m.label.clone())
                    .unwrap_or_else(|| parts.get(2).unwrap_or(&"").to_string()),
                m.map(|m| m.provider.clone()).unwrap_or_default(),
                parts.get(3).unwrap_or(&"").to_string(),
                g.requests.to_string(),
                g.tokens.input.to_string(),
                g.tokens.output.to_string(),
                g.tokens.cache_write.to_string(),
                g.tokens.cache_read.to_string(),
                g.tokens.total.to_string(),
                // Un coût inconnu reste VIDE, jamais 0 : dans un tableur, un
                // zéro se somme et se fait passer pour de la gratuité.
                if g.cost_unknown {
                    String::new()
                } else {
                    format!("{:.6}", g.cost_usd)
                },
                format!("{:.6}", g.cost_without_cache_usd),
                format!("{:.3}", g.carbon.grams_co2e.min),
                format!("{:.3}", g.carbon.grams_co2e.mid),
                format!("{:.3}", g.carbon.grams_co2e.max),
                format!("{:.3}", g.carbon.energy_wh.mid),
                format!("{:.3}", g.carbon.water_l.mid),
            ]
        })
        .collect();

    // Ordre chronologique, puis décroissant en volume : lisible tel quel.
    body.sort_by(|a, b| {
        a[0].cmp(&b[0]).then_with(|| {
            let n = |s: &String| s.parse::<i64>().unwrap_or(0);
            n(&b[10]).cmp(&n(&a[10]))
        })
    });

    let mut rows = vec![header];
    rows.extend(body);
    rows
}

/// Annexe méthodologique : un facteur par ligne, avec sa citation.
///
/// Se joint à l'export de données. Un tableau de grammes sans les facteurs qui
/// l'ont produit n'est pas vérifiable — et la colonne `version_figee` dit,
/// ligne à ligne, ce qui reste à relever sur la publication avant un usage
/// audité.
pub fn methodology_rows(grid_key: Option<&str>) -> Vec<Vec<String>> {
    let mut rows = vec![[
        "groupe",
        "facteur",
        "valeur",
        "unite",
        "source",
        "citation",
        "version_figee",
        "reserve",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect::<Vec<String>>()];

    for r in crate::carbon::factors::factor_table(grid_key) {
        rows.push(vec![
            r.group.to_string(),
            r.key,
            r.value,
            r.unit.to_string(),
            r.source.to_string(),
            r.citation,
            if r.pinned { "oui" } else { "non" }.to_string(),
            r.note,
        ]);
    }
    rows
}

/// Sérialise en CSV, avec échappement RFC 4180.
pub fn to_csv(rows: &[Vec<String>]) -> String {
    rows.iter()
        .map(|r| {
            r.iter()
                .map(|c| {
                    if c.contains([',', '"', ';', '\n', '\r']) {
                        format!("\"{}\"", c.replace('"', "\"\""))
                    } else {
                        c.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join("\n")
}
