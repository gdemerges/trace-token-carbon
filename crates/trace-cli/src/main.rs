//! TRACE en ligne de commande.
//!
//! Le raccourci global et le popover couvrent le coup d'œil depuis n'importe
//! quelle application ; cette CLI couvre le cas où l'on est déjà dans un
//! terminal et où ouvrir une fenêtre serait plus lent que taper trois lettres.
//! Elle partage exactement le même cœur et le même index que l'application.

mod format;

use format::{co2, num, pad, pad_start, tokens, usd, water};
use trace_core::core::{self, SnapshotOptions};
use trace_core::i18n::{self, t, t1, tp};
use trace_core::util::now_ms;

/// Couleurs ANSI, désactivées hors terminal pour que `trace | grep` reste
/// lisible et que `--json` soit analysable.
struct Colors {
    dim: &'static str,
    off: &'static str,
    b: &'static str,
    amber: &'static str,
    teal: &'static str,
    blue: &'static str,
    red: &'static str,
}

const PLAIN: Colors =
    Colors { dim: "", off: "", b: "", amber: "", teal: "", blue: "", red: "" };
const FANCY: Colors = Colors {
    dim: "\x1b[2m",
    off: "\x1b[0m",
    b: "\x1b[1m",
    amber: "\x1b[38;5;214m",
    teal: "\x1b[38;5;79m",
    blue: "\x1b[38;5;111m",
    red: "\x1b[38;5;203m",
};

fn is_tty() -> bool {
    // Pas de dépendance pour une question aussi simple : la variable est posée
    // par tous les terminaux, et son absence signifie une redirection.
    std::env::var_os("TERM").is_some() && std::env::var_os("NO_COLOR").is_none()
}

/// Jauge en blocs, même vocabulaire visuel que l'interface graphique.
fn bar(percent: Option<f64>, width: usize, c: &Colors) -> String {
    let Some(p) = percent else {
        return format!("{}{}{}", c.dim, "─".repeat(width), c.off);
    };
    let filled = ((p.min(100.0) / 100.0) * width as f64).round() as usize;
    let color = if p >= 85.0 { c.red } else { c.amber };
    format!(
        "{color}{}{}{}{}{}",
        "█".repeat(filled),
        c.off,
        c.dim,
        "░".repeat(width.saturating_sub(filled)),
        c.off
    )
}

/// Délai restant, en clair. `None` quand l'échéance est passée : une fenêtre
/// expirée a déjà été recalculée, l'annoncer serait faux.
fn until(ts: Option<i64>) -> Option<String> {
    let ms = ts.filter(|t| *t != 0)? - now_ms();
    if ms <= 0 {
        return None;
    }
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    Some(if h >= 24 {
        t1("duration.days", "n", h / 24)
    } else if h > 0 {
        tp("duration.hoursMinutes", &[("h", h.to_string()), ("m", format!("{m:02}"))])
    } else {
        t1("duration.minutes", "n", m)
    })
}

fn origin_key(limit_source: Option<&str>) -> &'static str {
    match limit_source {
        Some("provider") => "cli.origin.provider",
        Some("reset") => "cli.origin.reset",
        Some("live") => "cli.origin.live",
        Some("live-stale") => "cli.origin.liveStale",
        Some("derived") => "cli.origin.derived",
        Some("user") => "cli.origin.user",
        _ => "cli.origin.rolling",
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |flag: &str| args.iter().any(|a| a == flag);

    // La langue se fixe AVANT tout : les libellés de jauges et de sources sont
    // construits dans le cœur, pas ici.
    let lang_arg = args.iter().find_map(|a| a.strip_prefix("--lang="));
    let env_lang = ["LC_ALL", "LANGUAGE", "LANG"]
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .unwrap_or_default();
    let configured = trace_core::store::load_config().locale;
    let locale = i18n::resolve_locale(Some(lang_arg.unwrap_or(&configured)), Some(&env_lang));
    i18n::set_locale(locale);

    if has("--help") || has("-h") {
        println!("{}", t("cli.help"));
        return;
    }

    let raw_days = args
        .iter()
        .find_map(|a| a.strip_prefix("--days="))
        .unwrap_or("30");
    let opts = if raw_days == "all" {
        SnapshotOptions { all: true, ..SnapshotOptions::default() }
    } else {
        SnapshotOptions { days: raw_days.parse().ok(), ..SnapshotOptions::default() }
    };

    // L'index appartient à l'application tant qu'elle tourne. `save_index` le
    // vérifie de lui-même, mais le dire ici documente le contrat : la CLI lit
    // les mêmes chiffres et n'écrit que si la place est libre.
    let state = core::refresh(trace_core::store::load_config(), true);
    let snap = core::snapshot(&state, &opts);
    let tot = &snap.report.totals;

    if has("--json") {
        print_json(&snap, locale);
        return;
    }

    let c = if is_tty() { &FANCY } else { &PLAIN };
    println!();

    for g in &snap.gauges {
        let pct = match g.percent {
            None => "  —".to_string(),
            Some(p) => format!(
                "{}{}%",
                if g.approximate { "≈" } else { " " },
                pad_start(&format!("{}", p.round() as i64), 3)
            ),
        };
        let left = until(g.resets_at);
        // Même règle que l'interface : on ne cite l'origine d'un relevé que
        // faute d'échéance à annoncer.
        let note = match &left {
            Some(w) => t1("cli.resetIn", "when", w),
            None => format!("{}{}{}", c.dim, t(origin_key(g.limit_source.as_deref())), c.off),
        };
        // La trajectoire ne s'affiche que si la saturation précède la
        // réinitialisation : sinon la fenêtre se vide d'abord, et l'annoncer
        // ferait passer un régime normal pour un avertissement.
        let proj = match g.projection.as_ref().filter(|p| p.before_reset) {
            Some(p) => {
                let when = until(Some(p.at)).unwrap_or_else(|| t("cli.underMinute"));
                let key = if p.throttled { "cli.fullThrottled" } else { "cli.full" };
                format!("  {}{}{}", c.red, t1(key, "when", when), c.off)
            }
            None => String::new(),
        };
        let label = if g.full_label.is_empty() { &g.label } else { &g.full_label };
        println!(
            " {}{}{} {} {}  {note}{proj}",
            c.b,
            pad(label, 21),
            c.off,
            bar(g.percent, 24, c),
            pct
        );
    }

    let carbon = &tot.carbon.grams_co2e;
    println!();
    println!(
        " {}{} {}{}   {}{}{} {}{}{}   {}{}{} {}{}{}   {}{}{} {}CO₂e{}",
        c.dim, pad_start(&snap.range.days.to_string(), 3), t("cli.days"), c.off,
        c.amber, pad(&tokens(tot.tokens.total as f64), 9), c.off, c.dim, t("cli.tokens"), c.off,
        c.blue, pad(&usd(cost_or_none(tot)), 9), c.off, c.dim, t("cli.cost"), c.off,
        c.teal, pad(&co2(carbon.mid), 8), c.off, c.dim, c.off
    );
    println!(
        " {}          {} {}  {} {}   {} – {}{}",
        c.dim,
        pad(&num(tot.requests as f64, 0), 9),
        t("cli.requests"),
        pad(&usd(Some(tot.cache_savings_usd)), 9),
        t("cli.saved"),
        co2(carbon.min),
        co2(carbon.max),
        c.off
    );

    // Le détail carbone ne s'affiche que sur demande : la vue par défaut tient
    // en un écran, et la sensibilité n'intéresse qu'au moment de rédiger un
    // bilan.
    if has("--carbone") || has("--carbon") {
        let w = &tot.carbon.water_l;
        println!();
        println!(
            " {}{}{}     {} {}{} – {}{}",
            c.dim, t("cli.water"), c.off, pad(&water(w.mid), 10), c.dim, water(w.min), water(w.max), c.off
        );
        println!();
        println!(" {}{}{}", c.dim, t("cli.elsewhere"), c.off);
        for r in &tot.carbon_sensitivity {
            println!(
                "   {} {}   {}   {}× {}{}",
                pad(&r.label, 24),
                pad_start(&format!("{} g/kWh", num(r.intensity, 0)), 11),
                pad_start(&co2(r.grams_co2e.mid), 9),
                c.dim,
                num(r.ratio.unwrap_or(0.0), 2),
                c.off
            );
        }
        println!();
        println!(" {}{}{}", c.dim, t("cli.uncertainty"), c.off);
        for l in &tot.carbon_uncertainty {
            println!(
                "   {} {}   {}{}{}",
                pad(l.label, 24),
                pad_start(&format!("× {}", num(l.ratio, 1)), 11),
                c.dim,
                l.note,
                c.off
            );
        }
    }

    if has("--models") || has("--modeles") {
        println!();
        let total = tot.tokens.total.max(1) as f64;
        for m in &snap.report.by_model {
            let share = (m.tokens.total as f64 / total) * 100.0;
            let label = m.models.first().map(|x| x.label.clone()).unwrap_or_else(|| m.key.clone());
            println!(
                " {} {}  {}  {}  {}",
                pad(&label, 22),
                pad_start(&tokens(m.tokens.total as f64), 9),
                pad_start(&format!("{} %", num(share, 1)), 7),
                pad_start(&usd(if m.cost_unknown { None } else { Some(m.cost_usd) }), 9),
                pad_start(&co2(m.carbon.grams_co2e.mid), 8)
            );
        }
    }

    if has("--sources") {
        println!();
        for s in &snap.sources {
            let mark = if s.error.is_some() {
                format!("{}✗{}", c.red, c.off)
            } else if s.events_in_range > 0 {
                format!("{}●{}", c.teal, c.off)
            } else {
                format!("{}○{}", c.dim, c.off)
            };
            let detail = s
                .error
                .clone()
                .or_else(|| s.note.clone())
                .unwrap_or_else(|| t1("cli.requestsInRange", "n", num(s.events_in_range as f64, 0)));
            println!(" {mark} {} {}{}{}", pad(&s.label, 30), c.dim, detail, c.off);
        }

        // Mesure locale contre facture : la seule vérification externe possible.
        for r in &snap.report.reconciliation {
            let delta = r.delta_pct.unwrap_or(0.0);
            let dir = t(if delta >= 0.0 { "cli.more" } else { "cli.less" });
            let hot = if delta.abs() >= 5.0 { c.red } else { c.dim };
            println!(
                "   {}{}{} {} {}{}{}",
                c.dim,
                pad(&r.family, 28),
                c.off,
                tp("cli.recon", &[("local", tokens(r.local as f64)), ("billed", tokens(r.billed as f64))]),
                hot,
                tp("cli.reconDelta", &[
                    ("pct", num(delta.abs(), 1)),
                    ("dir", dir),
                    ("days", r.days.len().to_string())
                ]),
                c.off
            );
        }
    }
    println!();
}

/// Un coût inconnu ne doit pas se fondre dans un total en se faisant passer
/// pour la gratuité — jusque dans l'affichage.
fn cost_or_none(tot: &trace_core::aggregate::Totals) -> Option<f64> {
    if tot.cost_unknown && tot.cost_usd == 0.0 {
        None
    } else {
        Some(tot.cost_usd)
    }
}

/// Sortie machine, pour une barre de statut ou un script.
fn print_json(snap: &trace_core::core::Snapshot, locale: &str) {
    let tot = &snap.report.totals;
    let round4 = |v: f64| (v * 10_000.0).round() / 10_000.0;
    let out = serde_json::json!({
        "generatedAt": snap.generated_at,
        "days": snap.range.days,
        "from": snap.range.from,
        "dataHorizon": snap.data_horizon.from,
        "locale": locale,
        "tokens": tot.tokens.total,
        "requests": tot.requests,
        "costUSD": round4(tot.cost_usd),
        "cacheSavingsUSD": round4(tot.cache_savings_usd),
        "gramsCO2e": {
            "min": tot.carbon.grams_co2e.min,
            "mid": tot.carbon.grams_co2e.mid,
            "max": tot.carbon.grams_co2e.max,
        },
        "energyWh": tot.carbon.energy_wh.mid,
        "waterL": tot.carbon.water_l.mid,
        // Le total seul n'est pas exploitable dans un bilan : on livre aussi
        // de quoi le contester, sans quoi un script se contenterait de la
        // médiane.
        "sensitivity": tot.carbon_sensitivity.iter().map(|r| serde_json::json!({
            "grid": r.key, "gCO2ePerKWh": r.intensity,
            "gramsCO2e": r.grams_co2e.mid, "ratio": r.ratio,
        })).collect::<Vec<_>>(),
        "uncertainty": tot.carbon_uncertainty.iter().map(|l| serde_json::json!({
            "lever": l.key, "label": l.label, "ratio": l.ratio,
        })).collect::<Vec<_>>(),
        "gauges": snap.gauges.iter().map(|g| serde_json::json!({
            "id": g.id,
            "label": g.label,
            "percent": g.percent,
            "resetsAt": g.resets_at,
            "limitSource": g.limit_source,
            // Une barre de statut veut savoir s'il faut lever le pied, pas
            // seulement où l'on en est : la trajectoire part avec le niveau.
            "saturatesAt": g.projection.as_ref().filter(|p| p.before_reset).map(|p| p.at),
        })).collect::<Vec<_>>(),
        "reconciliation": snap.report.reconciliation.iter().map(|r| serde_json::json!({
            "family": r.family, "local": r.local, "billed": r.billed,
            "deltaPct": r.delta_pct, "days": r.days.len(),
        })).collect::<Vec<_>>(),
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
}
