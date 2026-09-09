//! Vérification de version : ce qu'on annonce, et surtout ce qu'on n'annonce
//! pas.
//!
//! Rien n'est téléchargé ni exécuté par ce module. Les seules décisions qu'il
//! prend — quelle version est postérieure, et quelle adresse on accepte
//! d'ouvrir — sont éprouvées ici sans le moindre appel réseau.

use serde_json::json;
use std::cmp::Ordering;
use trace_core::update::{check, compare_versions, pick_release, RELEASES_PAGE};

#[test]
fn comparaison_numerique_champ_par_champ() {
    assert_eq!(compare_versions("1.2.0", "1.1.9"), Ordering::Greater);
    assert_eq!(
        compare_versions("0.2.0", "0.10.0"),
        Ordering::Less,
        "10 est postérieur à 2, pas l'inverse — une comparaison de chaînes dirait le contraire"
    );
    assert_eq!(compare_versions("1.0.0", "1.0.0"), Ordering::Equal);
    assert_eq!(
        compare_versions("v1.0.1", "1.0.0"),
        Ordering::Greater,
        "le préfixe v est toléré"
    );
}

#[test]
fn une_pre_version_est_anterieure_a_la_stable_de_meme_numero() {
    // On ne propose jamais une pré-version à qui n'en a pas demandé.
    assert_eq!(compare_versions("1.0.0-beta.1", "1.0.0"), Ordering::Less);
    assert_eq!(compare_versions("1.0.0", "1.0.0-rc.2"), Ordering::Greater);
    assert_eq!(
        compare_versions("1.0.0-rc.1", "1.0.0-rc.2"),
        Ordering::Equal
    );
}

#[test]
fn un_format_inconnu_ne_declenche_rien() {
    assert_eq!(compare_versions("nightly", "1.0.0"), Ordering::Equal);
    assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
    assert_eq!(compare_versions("1.0.0.4", "1.0.0"), Ordering::Equal);
    assert!(pick_release(&json!({ "tag_name": "nightly" }), "0.1.0").is_none());
}

#[test]
fn seule_une_version_stable_et_posterieure_est_annoncee() {
    let url = "https://github.com/gdemerges/trace-token-carbon/releases/tag/v0.2.0";
    let rel = |extra: serde_json::Value| {
        let mut o = json!({ "html_url": url, "tag_name": "v0.2.0" });
        for (k, v) in extra.as_object().unwrap() {
            o[k] = v.clone();
        }
        o
    };
    assert!(pick_release(&rel(json!({})), "0.1.0").is_some());
    assert!(
        pick_release(&rel(json!({ "tag_name": "v0.1.0" })), "0.1.0").is_none(),
        "même version : rien à dire"
    );
    assert!(
        pick_release(&rel(json!({ "tag_name": "v0.0.9" })), "0.1.0").is_none(),
        "antérieure : rien à dire"
    );
    assert!(pick_release(&rel(json!({ "prerelease": true })), "0.1.0").is_none());
    assert!(pick_release(&rel(json!({ "draft": true })), "0.1.0").is_none());
    assert!(pick_release(&json!(null), "0.1.0").is_none());
}

#[test]
fn une_url_qui_ne_vient_pas_de_github_est_remplacee() {
    // La réponse est une donnée distante : on n'ouvre pas ce qu'elle dit sans
    // vérifier d'où ça vient.
    let found = pick_release(
        &json!({ "tag_name": "v9.9.9", "html_url": "https://ailleurs.example/piege" }),
        "0.1.0",
    )
    .expect("une version postérieure");
    assert_eq!(found.url, RELEASES_PAGE);
}

#[test]
fn les_notes_sont_bornees_et_coupees_sur_un_caractere_entier() {
    let long = "é".repeat(1000);
    let found = pick_release(&json!({ "tag_name": "v9.9.9", "body": long }), "0.1.0").unwrap();
    let notes = found.notes.expect("des notes");
    // Bornées en CARACTÈRES et non en octets : couper « é » en deux
    // produirait une chaîne invalide.
    assert_eq!(notes.chars().count(), 400);
}

#[test]
fn le_reglage_coupe_n_emet_aucun_appel() {
    // Le seul moyen de le vérifier sans réseau : la fonction rend `None` sans
    // même construire de client HTTP. Un appel prendrait des secondes ; celui-ci
    // est immédiat.
    let started = std::time::Instant::now();
    assert!(check("0.1.0", false).is_none());
    assert!(started.elapsed() < std::time::Duration::from_millis(50));
}
