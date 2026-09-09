//! Relevé direct : l'endpoint n'est pas documenté publiquement, donc
//! l'extraction ne doit présumer d'aucune forme précise et ne jamais deviner.
//!
//! Ces tests ne touchent pas au réseau : ils éprouvent la seule partie qui
//! puisse casser en silence le jour où la réponse change de forme.

use serde_json::json;
use trace_core::collectors::anthropic_oauth::{extract_windows, normalize_window};

#[test]
fn reconnait_une_reponse_a_objets_nommes() {
    let w = extract_windows(&json!({
        "five_hour": { "utilization": 79, "resets_at": 1788220800 },
        "seven_day": { "utilization": 34, "resets_at": 1788600000 },
    }));
    let by_type: std::collections::HashMap<&str, _> = w
        .iter()
        .filter_map(|x| normalize_window(&x.key).map(|t| (t, x)))
        .collect();
    assert_eq!(by_type["five_hour"].percent, 79.0);
    assert_eq!(
        by_type["five_hour"].resets_at,
        Some(1_788_220_800_000),
        "secondes epoch converties en ms"
    );
    assert_eq!(by_type["weekly"].percent, 34.0);
}

#[test]
fn reconnait_une_reponse_en_tableau_type() {
    let w = extract_windows(&json!({
        "limits": [
            { "type": "five_hour", "used_percent": 79, "resets_at": "2026-09-01T00:00:00Z" },
            { "type": "seven_day_opus", "used_percent": 12, "resets_at": "2026-09-05T00:00:00Z" },
        ]
    }));
    assert_eq!(w.len(), 2);
    assert_eq!(normalize_window(&w[0].key), Some("five_hour"));
    assert_eq!(normalize_window(&w[1].key), Some("weekly_opus"));
    assert_eq!(w[0].percent, 79.0);
    assert!(w[0].resets_at.is_some(), "une date ISO doit être reconnue comme une réinitialisation");
}

#[test]
fn une_fraction_zero_un_est_convertie_en_pourcentage() {
    // Certaines API rendent une fraction, d'autres un pourcentage. Les
    // confondre afficherait 0,79 % pour une fenêtre aux trois quarts pleine.
    let w = extract_windows(&json!({ "five_hour": { "utilization": 0.79, "resets_at": 1788220800 } }));
    assert!((w[0].percent - 79.0).abs() < 0.001, "obtenu {}", w[0].percent);
}

#[test]
fn cent_pour_cent_reste_cent_et_n_est_pas_pris_pour_une_fraction() {
    // La frontière du test précédent : 1 est ambigu, 100 ne l'est pas.
    let w = extract_windows(&json!({ "five_hour": { "used_percent": 100 } }));
    assert_eq!(w[0].percent, 100.0);
}

#[test]
fn une_forme_inconnue_ne_produit_aucune_fenetre_plutot_qu_un_chiffre_invente() {
    let w = extract_windows(&json!({ "message": "ok", "data": { "totally": "different" } }));
    assert!(w.is_empty());
    assert_eq!(normalize_window("quelque_chose"), None);
}

#[test]
fn les_variantes_de_nommage_connues_sont_toutes_reconnues() {
    for k in ["five_hour", "5h", "session", "fiveHour", "FIVE_HOUR"] {
        assert_eq!(normalize_window(k), Some("five_hour"), "{k}");
    }
    for k in ["seven_day", "weekly", "week", "7d"] {
        assert_eq!(normalize_window(k), Some("weekly"), "{k}");
    }
    for k in ["seven_day_opus", "weekly_opus", "opus"] {
        assert_eq!(normalize_window(k), Some("weekly_opus"), "{k}");
    }
}

#[test]
fn un_pourcentage_hors_bornes_est_ramene_dans_l_echelle() {
    // Une jauge à -3 % ou à 140 % n'a pas de sens à l'affichage, et une
    // réponse aberrante ne doit pas casser le rendu.
    let w = extract_windows(&json!({ "a": { "percent": 140 }, "b": { "percent": -3 } }));
    let mut pcts: Vec<f64> = w.iter().map(|x| x.percent).collect();
    pcts.sort_by(f64::total_cmp);
    assert_eq!(pcts, vec![0.0, 100.0]);
}

#[test]
fn une_structure_profondement_imbriquee_ne_fait_pas_boucler_l_extraction() {
    // La réponse n'est pas de forme garantie : une imbrication inattendue doit
    // s'arrêter, pas partir en récursion.
    let mut node = json!({ "used_percent": 50 });
    for _ in 0..40 {
        node = json!({ "nested": node });
    }
    let w = extract_windows(&node);
    assert!(w.is_empty(), "au-delà de la profondeur admise, on n'invente rien");
}
