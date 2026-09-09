//! Reconstruction des fenêtres de limitation de débit.
//!
//! Le problème : les plans Claude raisonnent en fenêtres glissantes — cinq
//! heures, puis sept jours — dont le plafond n'est publié nulle part et varie
//! selon le plan et le modèle. On ne peut donc pas coder un seuil en dur sans
//! mentir.
//!
//! La solution retenue, par ordre de fiabilité décroissante :
//!
//!  1. Le fournisseur donne directement un pourcentage — Codex le fait, et le
//!     relevé direct d'Anthropic aussi. On le prend tel quel : c'est le
//!     serveur qui parle.
//!  2. L'utilisateur a relevé son pourcentage réel (par `/usage` dans Claude
//!     Code) et l'a saisi : on remonte au plafond depuis ce point. C'est la
//!     seule méthode exacte côté Anthropic, parce que la seule qui s'appuie
//!     sur une vérité observée plutôt que déduite.
//!  3. Rien de tout cela : on affiche la consommation brute, SANS pourcentage.
//!     Une jauge sans échelle vaut mieux qu'une jauge fausse.
//!
//! Une quatrième méthode a été essayée puis retirée : l'auto-calibrage sur un
//! refus 429 passé. Confrontée à la réalité elle s'écartait d'un facteur 2,6 —
//! elle annonçait 31 % pour 79 % réels — parce que ni la fenêtre exacte du
//! refus ni la pondération interne d'Anthropic ne sont connues. Elle reste
//! calculée et exposée pour information dans le détail d'une jauge, mais ne
//! pilote plus aucun pourcentage affiché : sous-estimer son occupation ferait
//! croire à une marge inexistante, ce qui est précisément le risque contre
//! lequel cet outil existe.

use crate::collectors::{Event, Quota};
use crate::i18n::{t, t1, tp};
use crate::provenance;
use crate::store::Config;
use crate::util::{now_ms, Tokens};
use serde::Serialize;
use std::collections::HashMap;

const HOUR_MS: f64 = 3_600_000.0;

/// Fenêtres Anthropic.
///
/// `live_only` marque une fenêtre qu'on n'affiche que si le serveur la
/// mentionne : la limite Opus hebdomadaire n'existe pas sur tous les plans, et
/// une jauge vide en permanence serait du bruit.
pub struct WindowSpec {
    pub id: &'static str,
    pub hours: f64,
    pub live_only: bool,
}

pub const WINDOWS: &[WindowSpec] = &[
    WindowSpec { id: "five_hour", hours: 5.0, live_only: false },
    WindowSpec { id: "weekly", hours: 168.0, live_only: false },
    WindowSpec { id: "weekly_opus", hours: 168.0, live_only: true },
];

/// Nom du produit auquel la fenêtre se rattache.
///
/// Distinct du fournisseur : on dit « Codex » et non « OpenAI », parce que
/// c'est le nom sous lequel l'utilisateur connaît la limite qu'il regarde.
fn product(family: &str) -> &'static str {
    match family {
        "openai" => "Codex",
        _ => "Claude",
    }
}

pub fn window_label(id: &str) -> String {
    t(&format!("window.{id}"))
}

/// Nomme une fenêtre à partir de sa durée.
///
/// La première version appelait « Hebdomadaire » tout ce qui dépassait 168 h.
/// Le jour où Codex a ajouté une fenêtre mensuelle, deux lignes homonymes se
/// sont retrouvées côte à côte. Le libellé suit donc la durée réelle, y
/// compris pour des durées qu'on n'avait pas anticipées.
pub fn duration_label(hours: f64) -> String {
    if hours < 24.0 {
        return t1("window.session", "n", hours.round() as i64);
    }
    let days = (hours / 24.0).round() as i64;
    match days {
        1 => t("window.daily"),
        7 => t("window.weekly"),
        28..=31 => t("window.monthly"),
        _ => t1("window.nDays", "n", days),
    }
}

/// Écarte les fenêtres qu'un fournisseur ne rapporte plus.
///
/// Codex publie toutes ses fenêtres dans le même événement : celles dont le
/// dernier relevé est nettement antérieur au plus récent ont disparu de son
/// jeu de limites. Les garder produisait des jauges fantômes — une fenêtre de
/// 5 h vieille de 54 jours affichée à côté d'une mensuelle du jour.
const OBSOLETE_AFTER_MS: i64 = 24 * 3_600_000;

/// Durée au-delà de laquelle un relevé serveur cesse d'être présenté comme du
/// direct. Elle suit la cadence d'interrogation : à un relevé tous les quarts
/// d'heure, exiger moins marquerait « daté » un relevé parfaitement normal.
pub const LIVE_FRESH_MS: i64 = 45 * 60 * 1000;

/// Fenêtre d'observation de la cadence courante.
///
/// Assez longue pour ne pas confondre une pause de deux minutes avec un arrêt,
/// assez courte pour que la projection suive un changement de rythme. Sur une
/// fenêtre de cinq heures, la moyenne depuis le début ne décrirait plus rien :
/// c'est le rythme des dernières minutes qui dit quand on heurtera le plafond.
pub const PACE_WINDOW_MS: i64 = 45 * 60 * 1000;

const FIVE_HOUR_MS: f64 = 5.0 * HOUR_MS;

/// Assez de cycles pour couvrir une semaine (168 / 5 ≈ 34), avec de la marge.
/// Au-delà, la saturation tombe forcément après la réinitialisation
/// hebdomadaire : il n'y a plus rien à annoncer.
const MAX_CYCLES: usize = 40;

/// Les événements utilisables pour reconstruire l'occupation d'une fenêtre.
///
/// Seules les sources à granularité « requête » conviennent. Un agrégat
/// journalier est horodaté à minuit : le verser dans une fenêtre de cinq
/// heures déversait la consommation d'une journée entière — et de toutes les
/// machines de l'organisation — dans la seule fenêtre contenant minuit.
pub fn window_events<'a>(events: &'a [Event], family: &str) -> Vec<&'a Event> {
    events
        .iter()
        .filter(|e| {
            provenance::is_request_grain(&e.source) && provenance::meta(&e.source).family == family
        })
        .collect()
}

#[derive(Debug, Default)]
pub struct Consumption {
    pub tokens: Tokens,
    pub requests: i64,
    pub by_model: HashMap<String, Tokens>,
}

/// Somme des tokens et requêtes sur un intervalle.
pub fn consumption_between(events: &[&Event], from: i64, to: i64) -> Consumption {
    let mut c = Consumption::default();
    for e in events {
        if e.ts < from || e.ts > to {
            continue;
        }
        c.tokens.add(&e.tokens);
        c.requests += if e.requests != 0 { e.requests } else { 1 };
        c.by_model.entry(e.model.clone()).or_insert_with(Tokens::empty).add(&e.tokens);
    }
    c
}

/// Le poids d'un token vis-à-vis d'un quota n'est pas uniforme : une lecture
/// de cache pèse bien moins qu'un token généré. On calcule donc une
/// consommation « pondérée », qui suit de bien plus près le comportement réel
/// des plafonds qu'un total brut dominé par le cache.
pub fn weighted_usage(t: &Tokens) -> f64 {
    t.input as f64
        + t.output as f64 * 5.0
        + t.cache_write as f64 * 1.25
        + t.cache_read as f64 * 0.1
}

/// Déduit le plafond d'une fenêtre à partir d'un pourcentage relevé par
/// l'utilisateur : si 3,8 M pondérés valent 72 %, le plafond vaut 3,8 M / 0,72.
/// Produit en croix, mais ancré sur une valeur vraie plutôt qu'une inférence.
pub fn limit_from_observed_percent(
    events: &[&Event],
    window_start: i64,
    now: i64,
    percent: f64,
) -> Option<f64> {
    if percent <= 0.0 || percent > 100.0 {
        return None;
    }
    let used = weighted_usage(&consumption_between(events, window_start, now).tokens);
    if used <= 0.0 {
        return None;
    }
    Some(used / (percent / 100.0))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    pub limit: f64,
    pub observed_at: i64,
    pub samples: usize,
}

/// Calibre un plafond à partir des refus 429 observés. Exposé pour
/// information ; ne pilote aucun pourcentage affiché.
pub fn calibrate_from_rejections(
    events: &[&Event],
    quota: &[Quota],
    window_id: &str,
    hours: f64,
) -> Option<Calibration> {
    let rejections: Vec<&Quota> = quota
        .iter()
        .filter(|q| {
            q.source == "claude-code"
                && q.status.as_deref() == Some("rejected")
                && q.kind == window_id
                && q.resets_at != 0
                // Un plafond de dépense mensuel bloque la requête sans que la
                // fenêtre soit pleine : le retenir fausserait l'échelle.
                && q.cause == crate::collectors::Cause::Window
        })
        .collect();
    if rejections.is_empty() {
        return None;
    }

    let mut best = 0.0;
    let mut at = 0;
    for r in &rejections {
        let start = r.resets_at - (hours * HOUR_MS) as i64;
        let used = weighted_usage(&consumption_between(events, start, r.ts).tokens);
        if used > best {
            best = used;
            at = r.ts;
        }
    }
    (best > 0.0).then_some(Calibration { limit: best, observed_at: at, samples: rejections.len() })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub at: i64,
    pub in_ms: f64,
    pub rate_per_hour: f64,
    /// Une fenêtre glissante n'annonce pas de réinitialisation : rien ne vient
    /// absorber la trajectoire, la saturation est donc à prendre au sérieux.
    pub before_reset: bool,
    /// Vrai quand la limite 5 h impose des pauses avant la saturation : le
    /// délai annoncé contient alors du temps d'attente, pas que du travail.
    pub throttled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gauge {
    pub id: String,
    pub provider: String,
    pub product: String,
    pub label: String,
    pub full_label: String,
    pub window_hours: f64,
    pub starts_at: i64,
    pub resets_at: Option<i64>,
    pub rolling: bool,
    pub tokens: Tokens,
    pub requests: i64,
    pub by_model: HashMap<String, Tokens>,
    pub used: f64,
    pub limit: Option<f64>,
    pub limit_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calibration: Option<Calibration>,
    pub calibrated_at: Option<i64>,
    pub approximate: bool,
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_age: Option<i64>,
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reported_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub calibratable: bool,
    pub projection: Option<Projection>,
}

struct Scale {
    limit: f64,
    remaining: f64,
}

/// Échelle exploitable d'une jauge : le plafond connu, sinon celui qu'implique
/// le pourcentage du serveur rapporté à la consommation mesurée sous lui.
fn scale_of(g: &Gauge) -> Option<Scale> {
    let percent = g.percent?;
    let limit = g.limit.or_else(|| {
        (g.used > 0.0 && percent > 0.0).then(|| g.used / (percent / 100.0))
    })?;
    if !limit.is_finite() || limit <= 0.0 {
        return None;
    }
    Some(Scale { limit, remaining: (((100.0 - percent) / 100.0) * limit).max(0.0) })
}

/// Temps réel jusqu'à saturation d'une fenêtre longue, verrou des 5 h compris.
///
/// On ne peut pas brûler sa semaine d'une traite : la fenêtre de cinq heures
/// coupe avant, et il faut attendre sa réinitialisation pour reprendre. Une
/// projection hebdomadaire qui l'ignore répond à une question que personne ne
/// pose — « combien de temps de consommation ininterrompue reste-t-il ? » — au
/// lieu de celle qu'on se pose : « quel jour vais-je être bloqué ? ».
///
/// La simulation avance par cycles : on consomme au rythme courant jusqu'à
/// épuiser ce que la fenêtre 5 h autorise encore, on attend sa
/// réinitialisation sans rien consommer, et on recommence avec un budget
/// plein. Si le rythme est trop lent pour saturer la fenêtre courte, aucune
/// attente n'est insérée et le résultat retombe sur la projection simple.
fn throttle_by_short_window(
    remaining: f64,
    rate_per_ms: f64,
    five_resets_at: i64,
    scale: &Scale,
    now: i64,
) -> Option<(f64, bool)> {
    let mut left = remaining;
    let mut elapsed = 0.0;
    let mut budget = scale.remaining;
    let mut cycle_end = (five_resets_at - now) as f64;
    let mut throttled = false;

    for _ in 0..MAX_CYCLES {
        // Ce qu'on peut brûler avant que la fenêtre courte ne bloque, ou avant
        // qu'elle ne se réinitialise d'elle-même — le premier des deux.
        let burnable = budget.min((cycle_end - elapsed) * rate_per_ms);
        if left <= burnable {
            return Some((elapsed + left / rate_per_ms, throttled));
        }
        left -= burnable;
        // On a touché le plafond des 5 h avant la fin du cycle : le temps mort
        // jusqu'à la réinitialisation est précisément ce que la projection
        // simple oubliait.
        if burnable < (cycle_end - elapsed) * rate_per_ms {
            throttled = true;
        }
        elapsed = cycle_end;
        budget = scale.limit;
        cycle_end = elapsed + FIVE_HOUR_MS;
    }
    None
}

/// Estime QUAND la fenêtre sera pleine, au rythme des dernières minutes.
///
/// Quatre refus délibérés, qui valent mieux qu'une projection séduisante :
///
///  - **Sans échelle fiable, pas de projection.** Extrapoler sur une échelle
///    inventée reviendrait à annoncer une heure précise à partir de rien.
///  - **Sans activité récente, pas de projection.** Une cadence nulle ne
///    sature jamais ; annoncer « dans 340 h » serait du bruit.
///  - **Une saturation postérieure à la réinitialisation n'en est pas une.**
///    Atteindre le plafond à 3 h du matin n'a aucune importance si la fenêtre
///    se vide à 2 h.
///  - **Une fenêtre longue n'est pas consommable d'une traite.** La limite de
///    cinq heures s'interpose ; l'ignorer annonçait l'épuisement d'une semaine
///    en une nuit.
pub fn project_saturation(
    gauge: &Gauge,
    events: &[Event],
    now: i64,
    siblings: &[Gauge],
) -> Option<Projection> {
    let percent = gauge.percent?;
    if percent >= 100.0 {
        return None;
    }
    let scale = scale_of(gauge)?;

    let family = if gauge.provider == "openai" { "openai" } else { "anthropic" };
    let recent = consumption_between(&window_events(events, family), now - PACE_WINDOW_MS, now);
    let pace_used = weighted_usage(&recent.tokens);
    if pace_used <= 0.0 {
        return None;
    }
    let rate_per_ms = pace_used / PACE_WINDOW_MS as f64;

    // Une fenêtre longue est bridée par la fenêtre courte du même fournisseur.
    // La fenêtre courte, elle, n'est bridée par rien : c'est elle le verrou.
    let mut in_ms = scale.remaining / rate_per_ms;
    let mut throttled = false;
    if gauge.window_hours > 5.0 {
        let five = siblings.iter().find(|s| {
            s.provider == gauge.provider && s.window_hours == 5.0 && s.id != gauge.id
        });
        if let Some(five) = five {
            if let Some(resets_at) = five.resets_at.filter(|r| *r > now) {
                if let Some(five_scale) = scale_of(five) {
                    // Rien dans l'horizon simulé : la fenêtre longue se
                    // réinitialisera avant d'être pleine, rien à annoncer.
                    let (capped, was_throttled) = throttle_by_short_window(
                        scale.remaining, rate_per_ms, resets_at, &five_scale, now,
                    )?;
                    in_ms = capped;
                    throttled = was_throttled;
                }
            }
        }
    }
    if !in_ms.is_finite() || in_ms <= 0.0 {
        return None;
    }

    Some(Projection {
        at: now + in_ms as i64,
        in_ms,
        rate_per_hour: rate_per_ms * HOUR_MS,
        before_reset: gauge.resets_at.map(|r| (now + in_ms as i64) < r).unwrap_or(true),
        throttled,
    })
}

/// Construit les jauges à afficher.
pub fn compute_gauges(events: &[Event], quota: &[Quota], config: &Config, now: i64) -> Vec<Gauge> {
    let mut gauges: Vec<Gauge> = Vec::new();

    // --- Anthropic / Claude Code -------------------------------------------
    let claude_events = window_events(events, "anthropic");
    if !claude_events.is_empty() {
        for w in WINDOWS {
            // Une réinitialisation annoncée dans le futur donne l'ancrage
            // exact de la fenêtre. À défaut, on retombe sur une fenêtre
            // glissante des `hours` dernières heures — et surtout PAS sur
            // `now + hours`, qui produirait une fenêtre vide commençant à
            // l'instant présent.
            let known = quota
                .iter()
                .filter(|q| q.kind == w.id && q.resets_at > now)
                .max_by_key(|q| q.ts);
            let resets_at = known.map(|q| q.resets_at);
            let span = (w.hours * HOUR_MS) as i64;
            let starts_at = resets_at.map(|r| r - span).unwrap_or(now - span);
            let rolling = known.is_none();

            let c = consumption_between(&claude_events, starts_at, now);
            let used = weighted_usage(&c.tokens);

            // Relevé en direct du serveur : il tranche. Aucune reconstruction
            // locale ne peut faire mieux qu'un chiffre communiqué par
            // Anthropic. Mais un relevé n'est « en direct » que tant qu'il est
            // frais : passé le délai on l'affiche encore — c'est la meilleure
            // information disponible — en disant son âge, jamais comme s'il
            // venait d'arriver.
            let live = quota
                .iter()
                .filter(|q| q.source == "anthropic-oauth" && q.kind == w.id && q.used_percent.is_some())
                .max_by_key(|q| q.ts);
            let live_age = live.map(|q| now - q.ts);
            let live_fresh = live_age.is_some_and(|a| a < LIVE_FRESH_MS);

            // Fenêtre propre à certains plans : sans relevé du serveur, on ne
            // sait même pas si elle s'applique à ce compte. On ne l'invente pas.
            if w.live_only && live.is_none() {
                continue;
            }

            let configured = config.limits.get(w.id).copied();
            let meta = config.limit_meta.get(w.id);
            let meta_source = meta.and_then(|m| m.source.as_deref());
            let calibrated = calibrate_from_rejections(&claude_events, quota, w.id, w.hours);

            let mut limit = None;
            let mut limit_source: Option<String> = None;
            if let Some(cfg) = configured {
                limit = Some(cfg);
                limit_source = Some(if meta_source == Some("user") { "user" } else { "configured" }.into());
            }

            // Le direct écrase tout ce qui précède.
            let percent = match live.and_then(|q| q.used_percent) {
                Some(p) => Some(p),
                None => limit.map(|l| (used / l * 100.0).min(100.0)),
            };
            if live.is_some() {
                limit_source = Some(if live_fresh { "live" } else { "live-stale" }.into());
            }

            let label = window_label(w.id);
            gauges.push(Gauge {
                id: format!("anthropic-{}", w.id),
                provider: "anthropic".into(),
                product: product("anthropic").into(),
                full_label: tp(
                    "window.full",
                    &[("product", product("anthropic").into()), ("window", label.to_lowercase())],
                ),
                label,
                window_hours: w.hours,
                starts_at,
                resets_at: live.and_then(|q| (q.resets_at != 0).then_some(q.resets_at)).or(resets_at),
                rolling: if live.is_some_and(|q| q.resets_at != 0) { false } else { rolling },
                tokens: c.tokens,
                requests: c.requests,
                by_model: c.by_model,
                used,
                limit,
                limit_source,
                calibration: calibrated,
                calibrated_at: meta.and_then(|m| m.at),
                approximate: false,
                percent,
                live_age,
                stale: live.is_some() && !live_fresh,
                reported_at: live.map(|q| q.ts),
                plan: None,
                // Inutile de proposer un calage manuel quand le serveur répond.
                calibratable: live.is_none(),
                projection: None,
            });
        }
    }

    // --- Codex ---------------------------------------------------------------
    // Le serveur fournit un pourcentage, mais daté du dernier tour. Si la
    // fenêtre correspondante a expiré depuis, ce chiffre ne décrit plus rien.
    // On s'en sert alors comme point de calibrage — le pourcentage relevé et
    // la consommation locale mesurée sur cette même fenêtre donnent le plafond
    // — puis on recalcule l'occupation de la fenêtre COURANTE. Résultat : une
    // jauge toujours à jour, à 0 % si Codex n'a pas servi depuis.
    let codex_events = window_events(events, "openai");
    let mut by_window: HashMap<String, &Quota> = HashMap::new();
    for q in quota.iter().filter(|q| q.source == "codex-cli" && q.used_percent.is_some()) {
        by_window
            .entry(q.kind.clone())
            .and_modify(|cur| {
                if q.ts > cur.ts {
                    *cur = q;
                }
            })
            .or_insert(q);
    }

    // Le relevé le plus récent fait référence : ce qui n'y figurait pas n'est
    // plus rapporté par le fournisseur.
    let newest = by_window.values().map(|q| q.ts).max().unwrap_or(0);
    by_window.retain(|_, q| newest - q.ts <= OBSOLETE_AFTER_MS);

    // L'ordre d'une table de hachage n'est pas stable : sans tri, les jauges
    // Codex changeraient de place d'un rafraîchissement à l'autre.
    let mut codex: Vec<(&String, &&Quota)> = by_window.iter().collect();
    codex.sort_by(|a, b| a.0.cmp(b.0));

    for (kind, q) in codex {
        let hours = q.window_minutes.map(|m| m / 60.0).unwrap_or(5.0);
        let span = (hours * HOUR_MS) as i64;
        let reported_resets_at = if q.resets_at != 0 { q.resets_at } else { q.ts + span };
        let expired = reported_resets_at <= now;
        let used_percent = q.used_percent.unwrap_or(0.0);

        // Plafond déduit du dernier relevé du fournisseur.
        let mut limit = None;
        if used_percent > 0.0 {
            let at_report =
                consumption_between(&codex_events, reported_resets_at - span, q.ts);
            let used_at_report = weighted_usage(&at_report.tokens);
            if used_at_report > 0.0 {
                limit = Some(used_at_report / (used_percent / 100.0));
            }
        }

        // Fenêtre à afficher : celle du fournisseur si elle court encore,
        // sinon une fenêtre glissante se terminant maintenant.
        let resets_at = (!expired).then_some(reported_resets_at);
        let starts_at = if expired { now - span } else { reported_resets_at - span };

        let c = consumption_between(&codex_events, starts_at, now);
        let used = weighted_usage(&c.tokens);

        let (percent, limit_source, approximate) = if !expired {
            // La fenêtre annoncée court toujours : le chiffre du serveur fait foi.
            (Some(used_percent), Some("provider".to_string()), false)
        } else if let Some(l) = limit {
            (Some((used / l * 100.0).min(100.0)), Some("derived".to_string()), true)
        } else if used > 0.0 {
            (None, None, false)
        } else {
            // Aucune activité depuis la réinitialisation : la fenêtre est vide.
            (Some(0.0), Some("reset".to_string()), false)
        };

        let label = duration_label(hours);
        gauges.push(Gauge {
            id: format!("codex-{kind}"),
            provider: "openai".into(),
            product: product("openai").into(),
            full_label: tp(
                "window.full",
                &[("product", product("openai").into()), ("window", label.to_lowercase())],
            ),
            label,
            window_hours: hours,
            starts_at,
            resets_at,
            rolling: expired,
            tokens: c.tokens,
            requests: c.requests,
            by_model: HashMap::new(),
            used,
            limit,
            limit_source,
            calibration: None,
            calibrated_at: None,
            approximate,
            percent,
            live_age: None,
            // Le relevé n'est plus « périmé » : on ne l'affiche plus tel quel,
            // on s'en sert pour calculer l'état courant.
            stale: false,
            reported_at: Some(q.ts),
            plan: q.plan.clone(),
            calibratable: false,
            projection: None,
        });
    }

    // La projection se pose en dernier : elle a besoin de la jauge terminée,
    // pourcentage et plafond compris, et des autres jauges pour retrouver la
    // fenêtre courte qui la bride.
    let snapshot = gauges.clone();
    for g in &mut gauges {
        g.projection = project_saturation(g, events, now, &snapshot);
    }
    gauges
}

/// Recalibre une fenêtre à partir d'un pourcentage relevé par l'utilisateur.
pub fn apply_user_calibration(
    config: &Config,
    events: &[Event],
    quota: &[Quota],
    gauge_id: &str,
    percent: f64,
    now: i64,
) -> Result<Config, String> {
    let window_id = gauge_id.strip_prefix("anthropic-").unwrap_or(gauge_id);
    let Some(w) = WINDOWS.iter().find(|x| x.id == window_id) else {
        return Err(t1("window.unknown", "id", gauge_id));
    };

    let claude_events = window_events(events, "anthropic");
    let known = quota.iter().filter(|q| q.kind == w.id && q.resets_at > now).max_by_key(|q| q.ts);
    let span = (w.hours * HOUR_MS) as i64;
    let starts_at = known.map(|q| q.resets_at - span).unwrap_or(now - span);

    let Some(limit) = limit_from_observed_percent(&claude_events, starts_at, now, percent) else {
        return Err(t("window.noUsage"));
    };

    let mut next = config.clone();
    next.limits.insert(w.id.to_string(), limit);
    next.limit_meta.insert(
        w.id.to_string(),
        crate::store::LimitMeta {
            source: Some("user".into()),
            at: Some(now),
            from_percent: Some(percent),
        },
    );
    Ok(next)
}

/// Instant présent par défaut, pour les appelants qui n'en imposent pas un.
pub fn default_now() -> i64 {
    now_ms()
}
