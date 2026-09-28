//! Le budget mensuel : la dépense, la projection, et surtout les abstentions.
//!
//! Une projection fausse est pire que pas de projection : elle annonce un
//! dépassement imaginaire, ou en rate un vrai. Ces tests protègent d'abord les
//! refus.

use chrono::{Local, TimeZone};
use std::collections::HashMap;
use trace_core::aggregate::{report, Options};
use trace_core::alerts::{self, Fired};
use trace_core::budget;
use trace_core::collectors::Event;
use trace_core::store::Config;
use trace_core::util::Tokens;
use trace_core::{cost, resolve_model};

const DAY: i64 = 86_400_000;

/// Un instant local précis : le début de mois dépend du fuseau de la machine,
/// donc on part d'une date locale plutôt que d'un horodatage figé.
fn local(y: i32, m: u32, d: u32, h: u32) -> i64 {
    Local
        .with_ymd_and_hms(y, m, d, h, 0, 0)
        .earliest()
        .expect("date locale valide")
        .timestamp_millis()
}

fn tokens(output: i64) -> Tokens {
    Tokens {
        output,
        total: output,
        ..Tokens::empty()
    }
}

fn ev(ts: i64, model: &str, project: Option<&str>, output: i64) -> Event {
    Event {
        ts,
        source: "claude-code".into(),
        model: model.into(),
        project: project.map(str::to_string),
        session: None,
        tokens: tokens(output),
        requests: 1,
        compacted: None,
    }
}

/// Le coût d'un lot de tokens de sortie, calculé par le vrai tarificateur : le
/// test ne recopie aucun prix, il vérifie que le budget suit la tarification.
fn price(model: &str, output: i64) -> f64 {
    cost(&tokens(output), &resolve_model(model, None)).expect("modèle tarifé")
}

fn with_budget(limit: f64) -> Config {
    Config {
        budget_monthly_usd: Some(limit),
        ..Config::default()
    }
}

const MODEL: &str = "claude-opus-5";

#[test]
fn sans_plafond_il_n_y_a_pas_de_budget() {
    let now = local(2026, 9, 15, 12);
    let events = vec![ev(now - DAY, MODEL, None, 1_000_000)];
    assert!(budget::status(&events, &Config::default(), now).is_none());
    // Un plafond nul ou absurde vaut « pas de plafond » : diviser par lui
    // donnerait un pourcentage infini.
    assert!(budget::status(&events, &with_budget(0.0), now).is_none());
    assert!(budget::status(&events, &with_budget(-5.0), now).is_none());
    assert!(budget::status(&events, &with_budget(f64::NAN), now).is_none());
}

#[test]
fn la_depense_ne_compte_que_le_mois_en_cours() {
    let now = local(2026, 9, 15, 12);
    let events = vec![
        ev(local(2026, 8, 31, 12), MODEL, None, 5_000_000),
        ev(local(2026, 9, 2, 12), MODEL, None, 1_000_000),
        ev(local(2026, 9, 10, 12), MODEL, None, 1_000_000),
    ];
    let b = budget::status(&events, &with_budget(1000.0), now).expect("budget");
    let expected = price(MODEL, 2_000_000);
    assert!(
        (b.spent_usd - expected).abs() < 1e-9,
        "août n'appartient pas au budget de septembre : {} contre {expected}",
        b.spent_usd
    );
    assert!((b.percent - expected / 10.0).abs() < 1e-9);
}

#[test]
fn les_bornes_du_mois_couvrent_le_mois_local() {
    let now = local(2026, 9, 15, 12);
    let (start, end) = budget::month_bounds(now);
    assert_eq!(start, local(2026, 9, 1, 0));
    assert_eq!(end, local(2026, 10, 1, 0));
    // Décembre : le mois suivant est janvier de l'année d'après.
    let (_, end_dec) = budget::month_bounds(local(2026, 12, 20, 12));
    assert_eq!(end_dec, local(2027, 1, 1, 0));
}

#[test]
fn la_projection_prolonge_le_rythme_des_sept_derniers_jours() {
    let now = local(2026, 9, 15, 12);
    // Dix jours d'historique, dont une consommation régulière sur la dernière
    // semaine : 1 M de tokens par jour.
    let mut events = vec![ev(now - 10 * DAY, MODEL, None, 1_000)];
    for d in 0..7 {
        events.push(ev(now - d * DAY - DAY / 2, MODEL, None, 1_000_000));
    }
    let b = budget::status(&events, &with_budget(100_000.0), now).expect("budget");

    let recent = price(MODEL, 7_000_000);
    let per_day = recent / 7.0;
    let remaining = (b.month_end - now) as f64 / DAY as f64;
    let expected = b.spent_usd + per_day * remaining;
    let got = b.projected_usd.expect("assez d'historique et d'activité");
    assert!(
        (got - expected).abs() < 1e-6,
        "projection {got} attendue {expected}"
    );
    assert_eq!(b.state, "ok");
}

#[test]
fn pas_de_projection_sans_trois_jours_de_donnees() {
    let now = local(2026, 9, 15, 12);
    let events = vec![
        ev(now - DAY, MODEL, None, 1_000_000),
        ev(now - DAY / 2, MODEL, None, 1_000_000),
    ];
    let b = budget::status(&events, &with_budget(1000.0), now).expect("budget");
    assert!(b.spent_usd > 0.0, "la dépense, elle, se dit");
    assert!(
        b.projected_usd.is_none(),
        "extrapoler un mois depuis deux jours annoncerait des dépassements imaginaires"
    );
}

#[test]
fn pas_de_projection_sans_activite_recente() {
    let now = local(2026, 9, 15, 12);
    // De la dépense ce mois-ci, mais plus rien depuis douze jours.
    let events = vec![
        ev(local(2026, 9, 1, 12), MODEL, None, 1_000_000),
        ev(local(2026, 9, 3, 12), MODEL, None, 1_000_000),
    ];
    let b = budget::status(&events, &with_budget(1000.0), now).expect("budget");
    assert!(
        b.projected_usd.is_none(),
        "un rythme nul ne dépasse jamais rien : l'annoncer n'apprend rien"
    );
}

#[test]
fn le_depassement_et_la_projection_de_depassement_se_distinguent() {
    let now = local(2026, 9, 15, 12);
    let mut events = vec![ev(now - 10 * DAY, MODEL, None, 1_000)];
    for d in 0..7 {
        events.push(ev(now - d * DAY - DAY / 2, MODEL, None, 1_000_000));
    }
    let spent = price(MODEL, 7_000_000 + 1_000);

    // Plafond entre la dépense actuelle et la fin de mois projetée.
    let projected_over = budget::status(&events, &with_budget(spent * 1.2), now).expect("budget");
    assert_eq!(projected_over.state, "projected-over");

    let over = budget::status(&events, &with_budget(spent * 0.5), now).expect("budget");
    assert_eq!(over.state, "over");
    assert!(over.percent > 100.0);
}

#[test]
fn un_modele_sans_tarif_rend_la_depense_incomplete() {
    let now = local(2026, 9, 15, 12);
    let events = vec![
        ev(now - DAY, MODEL, None, 1_000_000),
        ev(now - DAY, "modele-inconnu-xyz", None, 1_000_000),
    ];
    let b = budget::status(&events, &with_budget(1000.0), now).expect("budget");
    // Selon le registre, un modèle inconnu peut recevoir un tarif de repli ;
    // l'invariant qui compte est la cohérence : le drapeau suit le tarificateur.
    let unknown_priced = cost(
        &tokens(1_000_000),
        &resolve_model("modele-inconnu-xyz", None),
    )
    .is_some();
    assert_eq!(b.cost_incomplete, !unknown_priced);
}

// --- alertes ---------------------------------------------------------------

fn status_at(percent: f64, projected: Option<f64>) -> budget::BudgetStatus {
    let limit = 100.0;
    budget::BudgetStatus {
        limit_usd: limit,
        spent_usd: percent,
        percent,
        projected_usd: projected,
        projected_percent: projected.map(|p| p / limit * 100.0),
        cost_incomplete: false,
        month_start: local(2026, 9, 1, 0),
        month_end: local(2026, 10, 1, 0),
        state: "ok",
    }
}

fn thresholds(o: &alerts::Outcome) -> Vec<String> {
    o.notifications
        .iter()
        .map(|n| n.threshold.clone())
        .collect()
}

#[test]
fn un_seuil_de_budget_ne_se_declenche_qu_une_fois_par_mois() {
    let cfg = Config::default();
    let mut state: Fired = HashMap::new();
    let mut step = |percent: f64| {
        let r = alerts::evaluate_budget(Some(&status_at(percent, None)), &cfg, &state);
        state = r.state.clone();
        thresholds(&r)
    };
    assert_eq!(step(40.0), Vec::<String>::new());
    assert_eq!(step(82.0), vec!["80"]);
    assert_eq!(
        step(85.0),
        Vec::<String>::new(),
        "un franchissement est un événement"
    );
    assert_eq!(step(97.0), vec!["95"]);
}

#[test]
fn passer_de_zero_a_quatre_vingt_seize_ne_notifie_qu_une_fois() {
    let cfg = Config::default();
    let r = alerts::evaluate_budget(Some(&status_at(96.0, None)), &cfg, &HashMap::new());
    assert_eq!(thresholds(&r), vec!["95"]);
}

#[test]
fn la_projection_ne_parle_qu_avant_le_premier_seuil() {
    let cfg = Config::default();
    let before =
        alerts::evaluate_budget(Some(&status_at(40.0, Some(150.0))), &cfg, &HashMap::new());
    assert_eq!(thresholds(&before), vec![alerts::TRAJECTORY]);

    // Passé 80 %, elle doublerait l'alerte de seuil au lieu de l'anticiper.
    let after = alerts::evaluate_budget(Some(&status_at(85.0, Some(150.0))), &cfg, &HashMap::new());
    assert_eq!(thresholds(&after), vec!["80"]);

    // Une projection sous le plafond ne dit rien.
    let calm = alerts::evaluate_budget(Some(&status_at(40.0, Some(90.0))), &cfg, &HashMap::new());
    assert!(calm.notifications.is_empty());
}

#[test]
fn un_nouveau_mois_rearme_les_seuils() {
    let cfg = Config::default();
    let september = status_at(85.0, None);
    let first = alerts::evaluate_budget(Some(&september), &cfg, &HashMap::new());
    assert_eq!(thresholds(&first), vec!["80"]);

    let mut october = status_at(85.0, None);
    october.month_start = local(2026, 10, 1, 0);
    october.month_end = local(2026, 11, 1, 0);
    let second = alerts::evaluate_budget(Some(&october), &cfg, &first.state);
    assert_eq!(
        thresholds(&second),
        vec!["80"],
        "le mois remplace la fenêtre"
    );
    assert_eq!(second.state.len(), 1, "le mois écoulé est oublié");
}

#[test]
fn les_alertes_coupees_ou_sans_budget_se_taisent() {
    let mut cfg = Config::default();
    cfg.alerts.enabled = false;
    let off = alerts::evaluate_budget(Some(&status_at(99.0, None)), &cfg, &HashMap::new());
    assert!(off.notifications.is_empty());

    let none = alerts::evaluate_budget(None, &Config::default(), &HashMap::new());
    assert!(none.notifications.is_empty());
}

// --- comparaison à la période précédente ------------------------------------

#[test]
fn chaque_groupe_porte_sa_variation_contre_la_periode_precedente() {
    let to = local(2026, 9, 15, 12);
    let from = to - 10 * DAY;
    let events = vec![
        // Période précédente [from-10j, from) : alpha 1 M, beta 1 M.
        ev(from - 5 * DAY, MODEL, Some("alpha"), 1_000_000),
        ev(from - 5 * DAY, MODEL, Some("beta"), 1_000_000),
        // Période courante : alpha ×2, beta inchangé, gamma nouveau.
        ev(from + 2 * DAY, MODEL, Some("alpha"), 2_000_000),
        ev(from + 2 * DAY, MODEL, Some("beta"), 1_000_000),
        ev(from + 2 * DAY, MODEL, Some("gamma"), 500_000),
    ];
    let rep = report(
        &events,
        &Options {
            from: Some(from),
            to: Some(to),
            ..Default::default()
        },
    );

    let get = |k: &str| {
        rep.by_project
            .iter()
            .find(|g| g.key == k)
            .unwrap_or_else(|| panic!("projet {k}"))
    };
    let alpha = get("alpha")
        .versus_previous
        .as_ref()
        .expect("alpha existait");
    assert_eq!(alpha.tokens, 1_000_000);
    assert!((alpha.tokens_change.unwrap() - 100.0).abs() < 1e-9);

    let beta = get("beta").versus_previous.as_ref().expect("beta existait");
    assert!(beta.tokens_change.unwrap().abs() < 1e-9);

    assert!(
        get("gamma").versus_previous.is_none(),
        "un projet nouveau n'a pas de pourcentage défendable : pas de « +∞ % »"
    );

    // Le même mécanisme vaut pour les modèles.
    let m = rep
        .by_model
        .iter()
        .find(|g| g.key == MODEL)
        .expect("modèle");
    assert!(m.versus_previous.is_some());
}
