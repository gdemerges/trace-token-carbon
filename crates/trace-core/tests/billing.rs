//! Rapports de facturation : l'analyse des réponses, éprouvée sans réseau.
//!
//! Ces sources donnent la consommation telle qu'elle est FACTURÉE, tous
//! appareils confondus. Deux fautes guettent leur analyse, et les deux
//! gonfleraient le total : compter le cache deux fois — une fois dans
//! `input_tokens` qui l'inclut, une fois dans son propre champ — et tarifer
//! l'écriture de cache en plus de ses deux TTL.

use serde_json::json;
use trace_core::collectors::billing::{
    has_key, parse_anthropic_buckets, parse_cost_buckets, parse_openai_buckets,
};

#[test]
fn anthropic_isole_l_entree_non_cachee_quand_l_api_la_donne() {
    let buckets = vec![json!({
        "starting_at": "2026-09-01T00:00:00Z",
        "results": [{
            "model": "claude-opus-5",
            "workspace_id": "ws_1",
            "uncached_input_tokens": 1000,
            "input_tokens": 51000,
            "output_tokens": 200,
            "cache_read_input_tokens": 50000,
            "num_requests": 7
        }]
    })];
    let e = parse_anthropic_buckets(&buckets);
    assert_eq!(e.len(), 1);
    // `input_tokens` valait 51 000, cache compris. Le retenir compterait la
    // lecture de cache une seconde fois.
    assert_eq!(e[0].tokens.input, 1000);
    assert_eq!(e[0].tokens.cache_read, 50_000);
    assert_eq!(e[0].tokens.total, 1000 + 200 + 50_000);
    assert_eq!(e[0].requests, 7);
    assert_eq!(e[0].project.as_deref(), Some("ws_1"));
}

#[test]
fn anthropic_retombe_sur_input_tokens_quand_l_api_ne_detaille_pas() {
    let buckets = vec![json!({
        "starting_at": "2026-09-01T00:00:00Z",
        "results": [{ "model": "claude-sonnet-5", "input_tokens": 900, "output_tokens": 100 }]
    })];
    let e = parse_anthropic_buckets(&buckets);
    assert_eq!(e[0].tokens.input, 900);
    assert_eq!(e[0].tokens.total, 1000);
}

#[test]
fn anthropic_ventile_le_cache_par_ttl_sans_le_compter_deux_fois() {
    let buckets = vec![json!({
        "starting_at": "2026-09-01T00:00:00Z",
        "results": [{
            "model": "claude-opus-5",
            "uncached_input_tokens": 0,
            "output_tokens": 0,
            "cache_creation": { "ephemeral_5m_input_tokens": 300, "ephemeral_1h_input_tokens": 700 }
        }]
    })];
    let t = parse_anthropic_buckets(&buckets)[0].tokens;
    assert_eq!(
        t.cache_write, 1000,
        "le total d'écriture est la somme des deux TTL"
    );
    assert_eq!(t.cache_write5m, 300);
    assert_eq!(t.cache_write1h, 700);
    assert_eq!(
        t.total, 1000,
        "et non 2000 : l'écriture n'est comptée qu'une fois"
    );
}

#[test]
fn anthropic_ecarte_un_resultat_entierement_vide() {
    let buckets = vec![json!({
        "starting_at": "2026-09-01T00:00:00Z",
        "results": [{ "model": "claude-opus-5", "input_tokens": 0, "output_tokens": 0 }]
    })];
    assert!(parse_anthropic_buckets(&buckets).is_empty());
}

#[test]
fn openai_retranche_le_cache_de_l_entree() {
    let buckets = vec![json!({
        "start_time": 1788220800,
        "results": [{
            "model": "gpt-5",
            "project_id": "proj_1",
            "input_tokens": 12000,
            "input_cached_tokens": 10000,
            "output_tokens": 500,
            "num_model_requests": 3
        }]
    })];
    let e = parse_openai_buckets(&buckets);
    assert_eq!(
        e[0].tokens.input, 2000,
        "12 000 déclarés, dont 10 000 servis par le cache"
    );
    assert_eq!(e[0].tokens.cache_read, 10_000);
    assert_eq!(e[0].tokens.total, 12_500);
    assert_eq!(e[0].requests, 3);
}

#[test]
fn openai_ne_produit_pas_d_entree_negative() {
    // Une réponse incohérente — plus de cache que d'entrée — ne doit pas
    // produire un volume négatif qui se soustrairait au total.
    let buckets = vec![json!({
        "start_time": 1788220800,
        "results": [{ "model": "gpt-5", "input_tokens": 100, "input_cached_tokens": 500, "output_tokens": 10 }]
    })];
    let t = parse_openai_buckets(&buckets)[0].tokens;
    assert_eq!(t.input, 0);
    assert_eq!(t.total, 510);
}

#[test]
fn un_horodatage_en_secondes_comme_en_iso_est_reconnu() {
    let iso = parse_openai_buckets(&[json!({
        "starting_at": "2026-09-01T00:00:00Z",
        "results": [{ "model": "m", "output_tokens": 1 }]
    })]);
    let secs = parse_openai_buckets(&[json!({
        "start_time": 1788220800,
        "results": [{ "model": "m", "output_tokens": 1 }]
    })]);
    assert!(
        iso[0].ts > 1_700_000_000_000,
        "les ISO doivent devenir des ms"
    );
    assert_eq!(secs[0].ts, 1_788_220_800_000, "les secondes epoch aussi");
}

#[test]
fn le_cout_s_agrege_par_jour_et_accepte_les_deux_formes_de_montant() {
    // L'API rend le montant tantôt en nombre, tantôt en chaîne.
    let buckets = vec![
        json!({ "starting_at": "2026-09-01T12:00:00Z", "results": [{ "amount": 1.25 }, { "amount": "2.75" }] }),
        json!({ "starting_at": "2026-09-02T12:00:00Z", "results": [{ "amount": 4.0 }] }),
    ];
    let r = parse_cost_buckets(&buckets);
    assert!((r.total_usd - 8.0).abs() < 1e-9);
    assert_eq!(r.by_day.len(), 2);
}

#[test]
fn un_montant_illisible_est_ignore_pas_compte_comme_zero() {
    let buckets = vec![json!({
        "starting_at": "2026-09-01T12:00:00Z",
        "results": [{ "amount": "pas un nombre" }, { "amount": 3.0 }]
    })];
    assert!((parse_cost_buckets(&buckets).total_usd - 3.0).abs() < 1e-9);
}

#[test]
fn une_cle_vide_ne_compte_pas_comme_une_cle() {
    assert!(!has_key(None));
    assert!(!has_key(Some("")));
    assert!(!has_key(Some("   ")));
    assert!(has_key(Some("sk-ant-admin-factice")));
}
