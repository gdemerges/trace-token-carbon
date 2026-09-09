//! Ce que la barre d'état montre, et pourquoi.
//!
//! Ces décisions étaient mêlées au processus principal d'Electron, donc
//! couvertes par aucun test. Elles n'ont pourtant rien de graphique.

use trace_core::core::{Horizon, Snapshot, SnapshotRange};
use trace_core::present::{duration_label, primary_gauge, tray_fill, tray_title, tray_tooltip};
use trace_core::ratelimits::{Gauge, Projection};
use trace_core::store::Config;
use trace_core::util::Tokens;

fn gauge(id: &str, percent: Option<f64>, window_hours: f64) -> Gauge {
    Gauge {
        id: id.into(),
        provider: "anthropic".into(),
        product: "Claude".into(),
        label: "Session 5 h".into(),
        full_label: "Claude — session 5 h".into(),
        window_hours,
        starts_at: 0,
        resets_at: None,
        rolling: true,
        tokens: Tokens::empty(),
        requests: 0,
        by_model: Default::default(),
        used: 0.0,
        limit: None,
        limit_source: Some("live".into()),
        calibration: None,
        calibrated_at: None,
        approximate: false,
        percent,
        live_age: None,
        stale: false,
        reported_at: None,
        plan: None,
        calibratable: false,
        projection: None,
        next_live_in: None,
    }
}

/// Un instantané réduit à ce que la barre d'état lit.
///
/// Le rapport est construit par le vrai chemin — `aggregate::report` sur un
/// événement de synthèse — puis ses trois totaux sont posés à la valeur
/// attendue. Fabriquer la structure à la main aurait figé sa forme dans le
/// test, et l'aurait fait mentir le jour où elle change.
fn snap_with(gauges: Vec<Gauge>, tokens_total: i64, cost: f64, grams: f64) -> Snapshot {
    use trace_core::aggregate::{report, Options};
    use trace_core::collectors::Event;

    let event = Event {
        ts: 1_000,
        source: "claude-code".into(),
        model: "claude-opus-5".into(),
        project: None,
        session: None,
        tokens: Tokens {
            output: 1,
            total: 1,
            ..Tokens::empty()
        },
        requests: 1,
        compacted: None,
    };
    let mut rep = report(
        &[event],
        &Options {
            from: Some(0),
            to: Some(2_000),
            ..Default::default()
        },
    );
    rep.totals.tokens.total = tokens_total;
    rep.totals.cost_usd = cost;
    rep.totals.carbon.grams_co2e.mid = grams;

    Snapshot {
        generated_at: 0,
        range: SnapshotRange {
            from: 0,
            to: 0,
            days: 30,
            all: false,
        },
        data_horizon: Horizon {
            from: None,
            by_source: Default::default(),
        },
        live_status: None,
        report: rep,
        gauges,
        sources: vec![],
        config: Config::default(),
        has_keys: Default::default(),
        methodology: serde_json::Value::Null,
        stale_error: None,
        extra: serde_json::Value::Null,
    }
}

fn simple(gauges: Vec<Gauge>) -> Snapshot {
    snap_with(gauges, 1_500_000_000, 314.07, 26_900.0)
}

fn metric(name: &str) -> Config {
    Config {
        tray_metric: name.into(),
        ..Config::default()
    }
}

#[test]
fn a_duree_de_fenetre_egale_la_plus_remplie_s_affiche() {
    let s = simple(vec![
        gauge("a", Some(20.0), 5.0),
        gauge("b", Some(71.0), 5.0),
        gauge("c", Some(55.0), 5.0),
    ]);
    assert_eq!(primary_gauge(&s).unwrap().id, "b");
}

#[test]
fn la_fenetre_la_plus_courte_passe_avant_la_plus_remplie() {
    // C'était la plus remplie, ce qui désignait presque toujours
    // l'hebdomadaire — celle sur laquelle on ne décide rien dans l'heure.
    let s = simple(vec![
        gauge("weekly", Some(90.0), 168.0),
        gauge("session", Some(20.0), 5.0),
    ]);
    assert_eq!(primary_gauge(&s).unwrap().id, "session");
}

#[test]
fn une_jauge_sans_pourcentage_n_est_jamais_choisie() {
    let s = simple(vec![
        gauge("muette", None, 1.0),
        gauge("chiffree", Some(10.0), 168.0),
    ]);
    assert_eq!(primary_gauge(&s).unwrap().id, "chiffree");
    assert!(primary_gauge(&simple(vec![gauge("muette", None, 1.0)])).is_none());
}

#[test]
fn chaque_metrique_a_son_format_compact() {
    // La barre partage sa largeur avec l'horloge : chaque caractère se paie.
    let s = simple(vec![gauge("a", Some(71.4), 5.0)]);
    assert_eq!(tray_title(&s, &metric("session")), "71 %");
    assert_eq!(tray_title(&s, &metric("tokens")), "1.5 Md");
    assert_eq!(tray_title(&s, &metric("cost")), "$314");
    assert_eq!(tray_title(&s, &metric("carbon")), "26.9 kg");
}

#[test]
fn sans_echelle_sure_un_tiret_plutot_qu_un_zero_invente() {
    let s = simple(vec![gauge("a", None, 5.0)]);
    assert_eq!(tray_title(&s, &metric("session")), "—");
}

#[test]
fn les_tokens_passent_au_milliard_sans_changer_de_largeur() {
    let petit = snap_with(vec![], 4_200_000, 0.0, 0.0);
    assert_eq!(tray_title(&petit, &metric("tokens")), "4 M");
}

#[test]
fn une_ligne_par_fenetre_puis_le_total_de_la_periode() {
    let mut weekly = gauge("w", None, 168.0);
    weekly.full_label = "Claude — hebdomadaire".into();
    let s = simple(vec![gauge("a", Some(40.0), 5.0), weekly]);
    let tooltip = tray_tooltip(&s);
    let lines: Vec<&str> = tooltip.lines().collect();
    assert_eq!(lines[0], "TRACE");
    assert_eq!(lines[1], "Claude — session 5 h : 40 %");
    assert_eq!(lines[2], "Claude — hebdomadaire : —");
    assert_eq!(lines[3], "30 j : $314.07 · 26.9 kg CO₂e");
}

#[test]
fn la_trajectoire_figure_dans_l_infobulle_quand_elle_precede_la_reinitialisation() {
    let projection = |before_reset: bool| Projection {
        at: 0,
        in_ms: 95.0 * 60_000.0,
        rate_per_hour: 0.0,
        before_reset,
        throttled: false,
    };
    let mut g = gauge("a", Some(40.0), 5.0);
    g.projection = Some(projection(true));
    assert!(tray_tooltip(&simple(vec![g])).contains("1 h 35"));

    // Une saturation postérieure à la réinitialisation n'en est pas une.
    let mut g = gauge("a", Some(40.0), 5.0);
    g.projection = Some(projection(false));
    assert!(!tray_tooltip(&simple(vec![g])).contains("pleine dans"));
}

#[test]
fn les_trois_echelles_de_duree_sont_couvertes() {
    assert_eq!(duration_label(42.0 * 60_000.0), "42 min");
    assert_eq!(
        duration_label(3.0 * 3_600_000.0 + 10.0 * 60_000.0),
        "3 h 10"
    );
    assert_eq!(duration_label(50.0 * 3_600_000.0), "2 j");
    assert_eq!(duration_label(0.0), "un instant");
    assert_eq!(duration_label(f64::NAN), "un instant");
}

#[test]
fn le_remplissage_de_l_icone_suit_la_jauge_choisie() {
    // C'est la fenêtre qui bloquera en premier que l'icône doit montrer.
    let s = simple(vec![
        gauge("weekly", Some(90.0), 168.0),
        gauge("session", Some(25.0), 5.0),
    ]);
    assert_eq!(tray_fill(&s), Some(0.25));
    assert_eq!(tray_fill(&simple(vec![gauge("a", None, 5.0)])), None);
    // Un pourcentage aberrant ne doit pas déborder du rail.
    assert_eq!(
        tray_fill(&simple(vec![gauge("a", Some(140.0), 5.0)])),
        Some(1.0)
    );
}
