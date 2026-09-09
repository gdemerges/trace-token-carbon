//! Limites de débit : reconstruction des fenêtres, calibrage, projection.
//!
//! La règle qui gouverne tout ce module et que ces tests protègent : mieux
//! vaut aucune échelle qu'une échelle fausse. Sous-estimer l'occupation ferait
//! croire à une marge inexistante — le risque exact contre lequel cet outil
//! existe.

use trace_core::collectors::{Cause, Event, Quota};
use trace_core::ratelimits::{
    apply_user_calibration, compute_gauges, duration_label, weighted_usage, Gauge,
};
use trace_core::store::Config;
use trace_core::util::Tokens;

const H: i64 = 3_600_000;

fn tokens(output: i64) -> Tokens {
    Tokens {
        output,
        total: output,
        ..Tokens::empty()
    }
}

fn ev(ts: i64, output: i64) -> Event {
    Event {
        ts,
        source: "claude-code".into(),
        model: "claude-opus-5".into(),
        project: Some("p".into()),
        session: Some("s".into()),
        tokens: tokens(output),
        requests: 1,
        compacted: None,
    }
}

fn rejection(ts: i64, resets_at: i64, cause: Cause) -> Quota {
    Quota {
        source: "claude-code".into(),
        ts,
        kind: "five_hour".into(),
        status: Some("rejected".into()),
        resets_at,
        using_overage: false,
        cause,
        used_percent: None,
        window_minutes: None,
        plan: None,
    }
}

fn five_hour(gauges: &[Gauge]) -> &Gauge {
    gauges
        .iter()
        .find(|g| g.id == "anthropic-five_hour")
        .expect("la jauge 5 h")
}

#[test]
fn la_fenetre_glissante_regarde_en_arriere_pas_en_avant() {
    let now = trace_core::util::now_ms();
    // Un événement il y a deux heures DOIT tomber dans la fenêtre de 5 heures.
    // `now + hours` produirait une fenêtre vide commençant à l'instant présent.
    let events = vec![ev(now - 2 * H, 1000)];
    let g = compute_gauges(&events, &[], &Config::default(), now);
    let g = five_hour(&g);
    assert!(
        g.used > 0.0,
        "la fenêtre glissante doit couvrir les 5 dernières heures"
    );
    assert!(g.rolling);
    assert!(g.starts_at < now && g.starts_at >= now - 5 * H);
}

#[test]
fn un_refus_429_est_mesure_mais_ne_devient_pas_une_echelle() {
    let now = trace_core::util::now_ms();
    let resets_at = now - H;
    let events = vec![ev(resets_at - 4 * H, 200_000), ev(now - 60_000, 1000)];
    let quota = vec![rejection(resets_at - 60_000, resets_at, Cause::Window)];
    let gs = compute_gauges(&events, &quota, &Config::default(), now);
    let g = five_hour(&gs);

    // La mesure est faite et reste consultable...
    assert!(g.calibration.as_ref().is_some_and(|c| c.limit > 0.0));
    // ...mais elle ne pilote aucun pourcentage : elle s'est révélée fausse
    // d'un facteur 2,6 face au chiffre réel du serveur.
    assert_eq!(g.percent, None);
    assert!(
        g.used > 0.0,
        "la consommation de la fenêtre reste affichable"
    );
}

#[test]
fn un_refus_pour_plafond_de_depense_ne_calibre_pas_la_fenetre() {
    let now = trace_core::util::now_ms();
    let resets_at = now - H;
    let events = vec![ev(resets_at - 4 * H, 500_000), ev(now - 60_000, 1000)];
    // Un plafond de dépense mensuel ne dit rien de l'occupation de la fenêtre
    // 5 h : il ne doit produire aucune échelle.
    let quota = vec![rejection(resets_at - 60_000, resets_at, Cause::Spend)];
    let gs = compute_gauges(&events, &quota, &Config::default(), now);
    let g = five_hour(&gs);
    assert_eq!(g.limit, None);
    assert_eq!(
        g.percent, None,
        "mieux vaut aucune échelle qu'une échelle fausse"
    );
    assert!(
        g.calibration.is_none(),
        "un refus de dépense n'entre même pas dans la mesure"
    );
}

#[test]
fn un_plafond_renseigne_prime_sur_le_calibrage() {
    let now = trace_core::util::now_ms();
    let events = vec![ev(now - 1000, 1000)];
    let quota = vec![rejection(now - 2 * H, now - H, Cause::Window)];
    let mut config = Config::default();
    config.limits.insert("five_hour".into(), 1e6);
    let gs = compute_gauges(&events, &quota, &config, now);
    let g = five_hour(&gs);
    assert_eq!(g.limit_source.as_deref(), Some("configured"));
    assert_eq!(g.limit, Some(1e6));
}

#[test]
fn la_ponderation_reflete_le_cout_reel_des_classes_de_tokens() {
    let w = |t: Tokens| weighted_usage(&t);
    assert!(
        w(Tokens {
            output: 100,
            ..Tokens::empty()
        }) > w(Tokens {
            cache_read: 100,
            ..Tokens::empty()
        })
    );
    assert!(
        w(Tokens {
            input: 100,
            ..Tokens::empty()
        }) > w(Tokens {
            cache_read: 100,
            ..Tokens::empty()
        })
    );
    // Un total brut est dominé par le cache, qui pèse dix fois moins : c'est
    // toute la raison d'être de la pondération.
    assert!(
        w(Tokens {
            cache_read: 1000,
            ..Tokens::empty()
        }) < w(Tokens {
            output: 100,
            ..Tokens::empty()
        })
    );
}

#[test]
fn le_releve_de_l_utilisateur_donne_exactement_le_pourcentage_saisi() {
    let now = trace_core::util::now_ms();
    let events = vec![ev(now - 2 * H, 100_000)];
    let cfg = apply_user_calibration(
        &Config::default(),
        &events,
        &[],
        "anthropic-five_hour",
        72.0,
        now,
    )
    .expect("calibrage possible");

    let gs = compute_gauges(&events, &[], &cfg, now);
    let g = five_hour(&gs);
    let p = g.percent.expect("un pourcentage");
    assert!((p - 72.0).abs() < 0.01, "attendu 72 %, obtenu {p}");
    assert_eq!(g.limit_source.as_deref(), Some("user"));
    assert!(!g.approximate);
    assert_eq!(cfg.limit_meta["five_hour"].from_percent, Some(72.0));
}

#[test]
fn le_releve_de_l_utilisateur_prime_sur_le_calibrage_automatique() {
    let now = trace_core::util::now_ms();
    let resets_at = now - H;
    let events = vec![ev(resets_at - 4 * H, 500_000), ev(now - 60_000, 50_000)];
    let quota = vec![rejection(resets_at - 60_000, resets_at, Cause::Window)];
    let cfg = apply_user_calibration(
        &Config::default(),
        &events,
        &quota,
        "anthropic-five_hour",
        40.0,
        now,
    )
    .expect("calibrage possible");
    let gs = compute_gauges(&events, &quota, &cfg, now);
    let g = five_hour(&gs);
    assert_eq!(g.limit_source.as_deref(), Some("user"));
    assert!((g.percent.unwrap() - 40.0).abs() < 0.01);
}

#[test]
fn calibrer_sans_consommation_mesuree_echoue_explicitement() {
    let now = trace_core::util::now_ms();
    let err = apply_user_calibration(
        &Config::default(),
        &[],
        &[],
        "anthropic-five_hour",
        50.0,
        now,
    )
    .expect_err("sans consommation, le produit en croix n'a pas de sens");
    assert!(!err.is_empty());
}

#[test]
fn le_releve_en_direct_ecrase_le_calibrage_local() {
    let now = trace_core::util::now_ms();
    let events = vec![ev(now - 2 * H, 100_000)];
    // L'utilisateur a calibré à 72 %, mais le serveur dit 15 %. Aucune
    // reconstruction locale ne peut faire mieux qu'un chiffre du fournisseur.
    let cfg = apply_user_calibration(
        &Config::default(),
        &events,
        &[],
        "anthropic-five_hour",
        72.0,
        now,
    )
    .unwrap();
    let mut live = rejection(now - 60_000, now + 3 * H, Cause::Window);
    live.source = "anthropic-oauth".into();
    live.status = None;
    live.used_percent = Some(15.0);

    let gs = compute_gauges(&events, &[live], &cfg, now);
    let g = five_hour(&gs);
    assert_eq!(g.percent, Some(15.0));
    assert_eq!(g.limit_source.as_deref(), Some("live"));
    assert!(
        !g.calibratable,
        "inutile de proposer un calage quand le serveur répond"
    );
}

#[test]
fn un_releve_direct_trop_vieux_est_affiche_mais_signale_comme_date() {
    let now = trace_core::util::now_ms();
    let events = vec![ev(now - 2 * H, 100_000)];
    let mut old = rejection(now - 2 * H, now + 3 * H, Cause::Window);
    old.source = "anthropic-oauth".into();
    old.status = None;
    old.used_percent = Some(60.0);

    let gs = compute_gauges(&events, &[old], &Config::default(), now);
    let g = five_hour(&gs);
    // On l'affiche encore — c'est la meilleure information disponible — mais
    // en disant son âge, jamais comme s'il venait d'arriver.
    assert_eq!(g.percent, Some(60.0));
    assert!(g.stale);
    assert_eq!(g.limit_source.as_deref(), Some("live-stale"));
}

#[test]
fn une_fenetre_propre_a_certains_plans_n_est_pas_inventee() {
    let now = trace_core::util::now_ms();
    let events = vec![ev(now - H, 1000)];
    let gs = compute_gauges(&events, &[], &Config::default(), now);
    assert!(
        !gs.iter().any(|g| g.id == "anthropic-weekly_opus"),
        "sans relevé du serveur, on ne sait pas si cette limite s'applique au compte"
    );
}

#[test]
fn le_libelle_suit_la_duree_reelle_de_la_fenetre() {
    // La première version appelait « Hebdomadaire » tout ce qui dépassait
    // 168 h. Le jour où Codex a ajouté une mensuelle, deux lignes homonymes se
    // sont retrouvées côte à côte.
    assert_ne!(duration_label(168.0), duration_label(720.0));
    assert_eq!(duration_label(24.0), duration_label(24.0));
    assert!(duration_label(336.0).contains("14"));
}

#[test]
fn codex_dont_la_fenetre_a_expire_repart_a_zero_pas_au_chiffre_perime() {
    let now = trace_core::util::now_ms();
    let mut q = Quota {
        source: "codex-cli".into(),
        ts: now - 10 * H,
        kind: "five_hour".into(),
        status: None,
        resets_at: now - 5 * H, // expirée
        using_overage: false,
        cause: Cause::Unknown,
        used_percent: Some(80.0),
        window_minutes: Some(300.0),
        plan: None,
    };
    q.window_minutes = Some(300.0);

    // Aucune activité Codex depuis : la fenêtre s'est réinitialisée, et
    // afficher 80 % laisserait croire à une saturation qui n'existe plus.
    let gs = compute_gauges(&[], &[q], &Config::default(), now);
    let g = gs
        .iter()
        .find(|g| g.id == "codex-five_hour")
        .expect("la jauge Codex");
    assert_eq!(g.percent, Some(0.0));
    assert_eq!(g.limit_source.as_deref(), Some("reset"));
    assert!(g.rolling);
}

#[test]
fn une_fenetre_que_le_fournisseur_ne_rapporte_plus_disparait() {
    let now = trace_core::util::now_ms();
    let mk = |kind: &str, ts: i64, minutes: f64| Quota {
        source: "codex-cli".into(),
        ts,
        kind: kind.into(),
        status: None,
        resets_at: ts + (minutes * 60_000.0) as i64,
        using_overage: false,
        cause: Cause::Unknown,
        used_percent: Some(10.0),
        window_minutes: Some(minutes),
        plan: None,
    };
    // Une fenêtre de 5 h dont le dernier relevé date de 54 jours, à côté d'une
    // mensuelle du jour : la première a disparu du jeu de limites du
    // fournisseur, la garder produirait une jauge fantôme.
    let quota = vec![
        mk("five_hour", now - 54 * 24 * H, 300.0),
        mk("monthly", now - 60_000, 43_200.0),
    ];
    let gs = compute_gauges(&[], &quota, &Config::default(), now);
    assert!(gs.iter().any(|g| g.id == "codex-monthly"));
    assert!(!gs.iter().any(|g| g.id == "codex-five_hour"));
}

#[test]
fn des_fenetres_relevees_ensemble_sont_toutes_conservees() {
    let now = trace_core::util::now_ms();
    let mk = |kind: &str, minutes: f64| Quota {
        source: "codex-cli".into(),
        ts: now - 60_000,
        kind: kind.into(),
        status: None,
        resets_at: now + (minutes * 60_000.0) as i64,
        using_overage: false,
        cause: Cause::Unknown,
        used_percent: Some(10.0),
        window_minutes: Some(minutes),
        plan: None,
    };
    let quota = vec![mk("five_hour", 300.0), mk("monthly", 43_200.0)];
    let gs = compute_gauges(&[], &quota, &Config::default(), now);
    assert_eq!(
        gs.len(),
        2,
        "publiées dans le même relevé, elles valent toutes les deux"
    );
}

#[test]
fn sans_activite_recente_aucune_projection() {
    let now = trace_core::util::now_ms();
    // Consommation ancienne, rien dans la fenêtre de cadence : annoncer
    // « dans 340 h » serait du bruit.
    let events = vec![ev(now - 4 * H, 100_000)];
    let cfg = apply_user_calibration(
        &Config::default(),
        &events,
        &[],
        "anthropic-five_hour",
        50.0,
        now,
    )
    .unwrap();
    let gs = compute_gauges(&events, &[], &cfg, now);
    assert!(five_hour(&gs).projection.is_none());
}

#[test]
fn une_fenetre_longue_n_est_pas_consommable_d_une_traite() {
    let now = trace_core::util::now_ms();
    // Rythme soutenu dans les dernières minutes, sur les deux fenêtres.
    let events = vec![ev(now - 5 * 60_000, 400_000), ev(now - 60_000, 400_000)];

    let mut five = rejection(now - 60_000, now + 2 * H, Cause::Window);
    five.source = "anthropic-oauth".into();
    five.status = None;
    five.used_percent = Some(50.0);
    let mut weekly = five.clone();
    weekly.kind = "weekly".into();
    weekly.used_percent = Some(20.0);
    weekly.resets_at = now + 5 * 24 * H;

    let gs = compute_gauges(&events, &[five, weekly], &Config::default(), now);
    let w = gs
        .iter()
        .find(|g| g.id == "anthropic-weekly")
        .expect("la jauge hebdomadaire");
    let p = w.projection.as_ref().expect("une projection");
    // La limite de cinq heures s'interpose : l'ignorer annonçait l'épuisement
    // d'une semaine en une nuit. Le délai doit donc contenir du temps d'attente.
    assert!(
        p.throttled,
        "la fenêtre courte doit brider la projection hebdomadaire"
    );
    assert!(p.in_ms > 5.0 * 3_600_000.0);
}
