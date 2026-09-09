//! Registre et tarification — portage des cas qui gardaient déjà la version
//! Electron. Les intentions sont reprises telles quelles : ce sont elles qui
//! prouvent que le portage n'a rien changé aux chiffres.

use trace_core::models::{resolve_model, Confidence, CACHE_MULTIPLIERS};
use trace_core::pricing::{cost, cost_without_cache};
use trace_core::util::Tokens;

fn tokens(input: i64, output: i64) -> Tokens {
    Tokens {
        input,
        output,
        ..Tokens::empty()
    }
}

#[test]
fn resolution_des_identifiants_dates_vers_le_modele_canonique() {
    assert_eq!(
        resolve_model("claude-sonnet-4-5-20250929", None).id,
        "claude-sonnet-4-5"
    );
    assert_eq!(
        resolve_model("claude-opus-4-5-20251101", None).id,
        "claude-opus-4-5"
    );
    assert_eq!(
        resolve_model("claude-opus-5", None).pricing.unwrap().output,
        25.0
    );
    assert_eq!(
        resolve_model("claude-sonnet-5", None)
            .pricing
            .unwrap()
            .input,
        2.0
    );
}

#[test]
fn l_ordre_du_registre_protege_les_entrees_specifiques() {
    // `^claude-opus-4` est plus général que `^claude-opus-4-5` : si l'ordre
    // était perdu au portage, il l'avalerait, et le tarif passerait de 5 $ à
    // 15 $ par million sans que rien ne signale l'erreur.
    assert_eq!(resolve_model("claude-opus-4-5", None).id, "claude-opus-4-5");
    assert_eq!(resolve_model("claude-opus-4-1", None).id, "claude-opus-4-1");
    assert_eq!(
        resolve_model("claude-opus-4-20250101", None).id,
        "claude-opus-4-0"
    );
    assert_eq!(resolve_model("gpt-5-mini", None).id, "gpt-5-mini");
    assert_eq!(resolve_model("gpt-4.1-mini", None).id, "gpt-4.1-mini");
}

#[test]
fn un_modele_inconnu_reste_visible_plutot_que_disparaitre() {
    let m = resolve_model("un-modele-jamais-vu", None);
    assert_eq!(m.params.confidence, Confidence::Unknown);
    assert!(
        m.pricing.is_none(),
        "un tarif inconnu doit rester absent, pas devenir 0"
    );
}

#[test]
fn seuls_les_fournisseurs_collectes_sont_resolus() {
    // Gemini, Grok et Ollama ont été retirés des sources : leurs modèles ne
    // peuvent plus arriver, et retombent donc sur le profil inconnu — visible
    // comme tel dans l'interface plutôt que chiffré à tort.
    for id in ["gemini-2.5-pro", "grok-build", "llama3.1:70b"] {
        let m = resolve_model(id, None);
        assert_eq!(m.provider, "unknown", "{id}");
        assert!(m.pricing.is_none(), "{id} : coût inconnu, jamais nul");
    }
    assert_eq!(resolve_model("claude-opus-5", None).provider, "anthropic");
    assert_eq!(resolve_model("gpt-5", None).provider, "openai");
}

#[test]
fn la_casse_de_l_identifiant_est_sans_effet() {
    assert_eq!(resolve_model("CLAUDE-OPUS-5", None).id, "claude-opus-5");
}

#[test]
fn un_message_local_ne_coute_rien_et_le_dit() {
    let m = resolve_model("<synthetic>", None);
    // Zéro par CONSTRUCTION, pas par ignorance : la distinction est tout
    // l'intérêt du champ.
    assert_eq!(m.pricing.unwrap().input, 0.0);
    assert_eq!(m.params.confidence, Confidence::Disclosed);
    assert_eq!(cost(&tokens(1_000_000, 0), &m), Some(0.0));
}

#[test]
fn les_multiplicateurs_de_cache_sont_appliques_par_ttl() {
    let model = resolve_model("claude-opus-5", None); // 5 $ / 25 $ par million
    let t = Tokens {
        input: 1_000_000,
        cache_read: 1_000_000,
        cache_write5m: 1_000_000,
        cache_write1h: 1_000_000,
        ..Tokens::empty()
    };
    let expected = 5.0
        + 5.0 * CACHE_MULTIPLIERS.read
        + 5.0 * CACHE_MULTIPLIERS.write5m
        + 5.0 * CACHE_MULTIPLIERS.write1h;
    let got = cost(&t, &model).unwrap();
    assert!((got - expected).abs() < 1e-9, "{got} != {expected}");
}

#[test]
fn une_ecriture_de_cache_n_est_jamais_comptee_deux_fois() {
    // Le piège du portage, et il a mordu : `cache_write` est la SOMME des deux
    // TTL, gardée pour le volume. Le tarifer en plus des TTL facturerait
    // 1,25x ET 2x la même écriture. Le cas qui le révèle est le TTL 1 heure
    // pur, où `cache_write5m` vaut légitimement zéro.
    let model = resolve_model("claude-opus-5", None); // 5 $ par Mtok en entrée
    let t = Tokens {
        cache_write: 1_000_000,
        cache_write5m: 0,
        cache_write1h: 1_000_000,
        ..Tokens::empty()
    };
    let got = cost(&t, &model).unwrap();
    assert!(
        (got - 5.0 * CACHE_MULTIPLIERS.write1h).abs() < 1e-9,
        "attendu {} (2x seulement), obtenu {got}",
        5.0 * CACHE_MULTIPLIERS.write1h
    );
}

#[test]
fn un_fournisseur_sans_detail_de_ttl_est_attribue_au_cinq_minutes() {
    // La répartition se fait une seule fois, à la source. Un total sans détail
    // part au 5 minutes — le tarif le plus courant — plutôt que d'être perdu.
    let (total, w5, w1) = Tokens::split_cache_write(1_000_000, 0, 0);
    assert_eq!((total, w5, w1), (1_000_000, 1_000_000, 0));

    let model = resolve_model("claude-opus-5", None);
    let t = Tokens {
        cache_write: total,
        cache_write5m: w5,
        cache_write1h: w1,
        ..Tokens::empty()
    };
    let got = cost(&t, &model).unwrap();
    assert!((got - 5.0 * CACHE_MULTIPLIERS.write5m).abs() < 1e-9);
}

#[test]
fn un_detail_de_ttl_present_est_respecte_tel_quel() {
    assert_eq!(Tokens::split_cache_write(700, 0, 700), (700, 0, 700));
    assert_eq!(Tokens::split_cache_write(700, 200, 500), (700, 200, 500));
    // Total absent mais détail présent : le total se déduit, l'inverse jamais.
    assert_eq!(Tokens::split_cache_write(0, 200, 500), (700, 200, 500));
}

#[test]
fn un_cout_inconnu_reste_absent_jamais_zero() {
    // Un coût inconnu ne doit pas se fondre dans un total en se faisant passer
    // pour la gratuité.
    assert_eq!(
        cost(
            &tokens(1_000_000, 0),
            &resolve_model("modele-inconnu", None)
        ),
        None
    );
}

#[test]
fn le_cache_fait_bien_economiser() {
    let model = resolve_model("claude-opus-5", None);
    let t = Tokens {
        input: 1000,
        output: 500,
        cache_read: 1_000_000,
        cache_write5m: 100_000,
        ..Tokens::empty()
    };
    assert!(cost_without_cache(&t, &model) > cost(&t, &model));
}
