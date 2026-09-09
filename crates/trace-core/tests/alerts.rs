//! Alertes : ce qui doit prévenir, et surtout ce qui ne doit pas.
//!
//! Une alerte fausse détruit la confiance dans toutes les autres. Ces tests
//! protègent d'abord les abstentions.

use std::collections::HashMap;
use trace_core::alerts::{self, Fired};
use trace_core::ratelimits::{Gauge, Projection};
use trace_core::store::Config;
use trace_core::util::Tokens;

/// Instant figé : l'identité d'une fenêtre dépend de sa réinitialisation, donc
/// un instant recalculé à chaque appel rendrait le test non déterministe.
const T0: i64 = 1_788_000_000_000;
const H: i64 = 3_600_000;

fn gauge(percent: f64) -> Gauge {
    Gauge {
        id: "anthropic-five_hour".into(),
        provider: "anthropic".into(),
        product: "Claude".into(),
        label: "Session 5 h".into(),
        full_label: "Claude — session 5 h".into(),
        window_hours: 5.0,
        starts_at: T0 - 4 * H,
        resets_at: Some(T0 + H),
        rolling: false,
        tokens: Tokens::empty(),
        requests: 0,
        by_model: Default::default(),
        used: 0.0,
        limit: Some(1000.0),
        limit_source: Some("live".into()),
        calibration: None,
        calibrated_at: None,
        approximate: false,
        percent: Some(percent),
        live_age: None,
        stale: false,
        reported_at: None,
        plan: None,
        calibratable: false,
        projection: None,
        next_live_in: None,
    }
}

fn config() -> Config {
    Config::default()
}

fn thresholds(o: &alerts::Outcome) -> Vec<String> {
    o.notifications.iter().map(|n| n.threshold.clone()).collect()
}

#[test]
fn un_seuil_ne_se_declenche_qu_une_fois_par_fenetre() {
    let cfg = config();
    let mut state: Fired = HashMap::new();
    let mut step = |percent: f64| {
        let r = alerts::evaluate(&[gauge(percent)], &cfg, &state, T0);
        state = r.state.clone();
        thresholds(&r)
    };
    assert_eq!(step(40.0), Vec::<String>::new());
    assert_eq!(step(82.0), vec!["80"]);
    assert_eq!(
        step(84.0),
        Vec::<String>::new(),
        "répéter à chaque cycle de 60 s ferait de l'outil une nuisance"
    );
    assert_eq!(step(96.0), vec!["95"]);
    assert_eq!(step(97.0), Vec::<String>::new());
}

#[test]
fn jamais_sur_une_echelle_approximative() {
    // Cette estimation s'est révélée fausse d'un facteur 2,6 en conditions
    // réelles.
    let mut g = gauge(99.0);
    g.approximate = true;
    g.limit_source = Some("derived".into());
    let r = alerts::evaluate(&[g], &config(), &HashMap::new(), T0);
    assert!(r.notifications.is_empty());
}

#[test]
fn jamais_sur_une_source_d_echelle_non_fiable() {
    // La liste des sources de confiance est le cœur de la règle : une source
    // inconnue ne doit pas y entrer par défaut.
    for source in ["derived", "reset", "observed"] {
        let mut g = gauge(99.0);
        g.limit_source = Some(source.into());
        let r = alerts::evaluate(&[g], &config(), &HashMap::new(), T0);
        assert!(r.notifications.is_empty(), "{source} ne doit pas déclencher d'alerte");
    }
    for source in ["live", "live-stale", "user", "provider", "configured"] {
        let mut g = gauge(99.0);
        g.limit_source = Some(source.into());
        let r = alerts::evaluate(&[g], &config(), &HashMap::new(), T0);
        assert_eq!(r.notifications.len(), 1, "{source} doit déclencher");
    }
}

#[test]
fn un_bond_de_zero_a_quatre_vingt_seize_ne_produit_qu_une_notification() {
    let r = alerts::evaluate(&[gauge(96.0)], &config(), &HashMap::new(), T0);
    assert_eq!(r.notifications.len(), 1);
    assert_eq!(r.notifications[0].threshold, "95", "le seuil le plus haut franchi");
    assert_eq!(r.notifications[0].urgency, "critical");
}

#[test]
fn une_nouvelle_fenetre_rearme_les_seuils() {
    let cfg = config();
    let mut g1 = gauge(90.0);
    g1.resets_at = Some(T0 + 1000);
    let first = alerts::evaluate(&[g1], &cfg, &HashMap::new(), T0);
    assert_eq!(first.notifications.len(), 1);

    // Même jauge, fenêtre suivante : le seuil doit pouvoir se redéclencher.
    let mut g2 = gauge(90.0);
    g2.resets_at = Some(T0 + 5 * H);
    let second = alerts::evaluate(&[g2], &cfg, &first.state, T0);
    assert_eq!(second.notifications.len(), 1);
}

#[test]
fn l_etat_des_fenetres_mortes_n_est_pas_conserve() {
    let cfg = config();
    let mut g = gauge(90.0);
    g.resets_at = Some(T0 + 1000);
    let r1 = alerts::evaluate(&[g], &cfg, &HashMap::new(), T0);
    assert_eq!(r1.state.len(), 1);
    // La jauge disparaît : son état ne doit pas s'accumuler indéfiniment.
    let r2 = alerts::evaluate(&[], &cfg, &r1.state, T0);
    assert_eq!(r2.state.len(), 0);
}

#[test]
fn desactivables_et_seuils_personnalisables() {
    let mut off = config();
    off.alerts.enabled = false;
    assert!(alerts::evaluate(&[gauge(99.0)], &off, &HashMap::new(), T0).notifications.is_empty());

    let mut custom = config();
    custom.alerts.thresholds = vec![50.0];
    let r = alerts::evaluate(&[gauge(55.0)], &custom, &HashMap::new(), T0);
    assert_eq!(thresholds(&r), vec!["50"]);
}

#[test]
fn la_trajectoire_previent_avant_le_premier_seuil_et_pas_apres() {
    let cfg = config();
    let projection = |before_reset: bool| Projection {
        at: T0 + 30 * 60_000,
        in_ms: 30.0 * 60_000.0,
        rate_per_hour: 1000.0,
        before_reset,
        throttled: false,
    };

    // À 40 %, en montant vite : il reste le temps d'agir, l'alerte a une valeur.
    let mut early = gauge(40.0);
    early.projection = Some(projection(true));
    let r = alerts::evaluate(&[early], &cfg, &HashMap::new(), T0);
    assert_eq!(thresholds(&r), vec!["trajectoire"]);

    // À 85 %, l'alerte de seuil a déjà parlé : la doubler n'anticipe rien.
    let mut late = gauge(85.0);
    late.projection = Some(projection(true));
    let r = alerts::evaluate(&[late], &cfg, &HashMap::new(), T0);
    assert_eq!(thresholds(&r), vec!["80"]);
}

#[test]
fn une_saturation_posterieure_a_la_reinitialisation_n_alerte_pas() {
    // Atteindre le plafond après que la fenêtre se soit vidée n'est pas un
    // incident. C'est la condition qui rend l'alerte de trajectoire
    // défendable.
    let cfg = config();
    let mut g = gauge(40.0);
    g.projection = Some(Projection {
        at: T0 + 10 * H,
        in_ms: 10.0 * H as f64,
        rate_per_hour: 100.0,
        before_reset: false,
        throttled: false,
    });
    assert!(alerts::evaluate(&[g], &cfg, &HashMap::new(), T0).notifications.is_empty());
}

#[test]
fn une_fenetre_glissante_rearme_a_l_heure_pas_a_la_minute() {
    // Sans réinitialisation annoncée, l'identité se quantifie à l'heure : une
    // saturation qui dure une demi-journée mérite plus d'un rappel, mais pas
    // un rappel par minute.
    let mut a = gauge(90.0);
    a.resets_at = None;
    a.starts_at = T0;
    let mut b = a.clone();
    b.starts_at = T0 + 60_000; // une minute plus tard
    assert_eq!(alerts::window_key(&a), alerts::window_key(&b));

    let mut c = a.clone();
    c.starts_at = T0 + H; // une heure plus tard
    assert_ne!(alerts::window_key(&a), alerts::window_key(&c));
}
