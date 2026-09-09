//! Annexe méthodologique : la table des facteurs, ses citations, et ce qu'il
//! reste à figer.
//!
//! Ce que ces tests protègent : un chiffre carbone n'est opposable que si
//! chaque facteur remonte à une publication identifiée. Un facteur qui perdrait
//! sa source, ou une citation qui cesserait d'avouer qu'elle n'est pas figée,
//! rendraient le total invérifiable sans que rien ne le signale.

use trace_core::aggregate::{methodology_rows, to_csv};
use trace_core::carbon::factors::factor_table;
use trace_core::carbon::sources::{all, cite, source, unpinned_sources};

#[test]
fn toute_constante_est_sourcee() {
    for r in factor_table(None) {
        assert!(
            source(r.source).is_some(),
            "{} / {} cite une source inexistante : {}",
            r.group,
            r.key,
            r.source
        );
        assert!(!r.citation.is_empty(), "{} n'a pas de citation", r.key);
    }
}

#[test]
fn une_source_non_figee_l_avoue_dans_sa_citation() {
    // Une fausse précision de citation est pire qu'une citation absente :
    // elle passe la relecture.
    for s in all() {
        let c = cite(s.id);
        assert_eq!(
            !s.pinned,
            c.contains("NON RELEVÉES"),
            "{} : la citation doit dire si la version est relevée",
            s.id
        );
    }
}

#[test]
fn les_sources_a_figer_sont_listees_plutot_qu_oubliees() {
    let todo = unpinned_sources();
    // Une liste vide serait la condition d'entrée dans un livrable audité :
    // ce n'est pas encore le cas, et le test le garde visible.
    assert!(!todo.is_empty());
    for s in &todo {
        assert!(
            !s.url.is_empty(),
            "{} : une source à figer doit au moins porter son URL",
            s.id
        );
    }
    // Les dérivations internes, elles, sont figées par leur version.
    assert!(todo.iter().all(|s| s.id != "traceDerived"));
    assert!(todo.iter().all(|s| s.id != "inferredFromBehaviour"));
}

#[test]
fn preciser_le_mix_ne_cite_que_celui_la() {
    // Citer les onze mix quand le calcul n'en emploie qu'un est la faute qu'un
    // vérificateur relève en premier.
    let all_grids = factor_table(None);
    let one = factor_table(Some("france"));
    let count = |rows: &[trace_core::carbon::factors::FactorRow]| {
        rows.iter().filter(|r| r.group == "Mix électrique").count()
    };
    assert!(count(&all_grids) > 1);
    assert_eq!(count(&one), 1);
}

#[test]
fn l_annexe_s_exporte_avec_un_en_tete_complet() {
    let rows = methodology_rows(Some("us-average"));
    assert_eq!(rows[0].len(), 8);
    assert_eq!(rows[0][6], "version_figee");
    assert!(
        rows.len() > 20,
        "une annexe d'une poignée de lignes ne prouverait rien"
    );
    // Toutes les lignes ont la même largeur : un CSV bancal casse le tableur.
    assert!(rows.iter().all(|r| r.len() == 8));
}

#[test]
fn le_csv_echappe_les_notes_qui_contiennent_des_virgules() {
    let csv = to_csv(&methodology_rows(Some("france")));
    // Les réserves sont des phrases : elles contiennent virgules et
    // apostrophes, et doivent ressortir entre guillemets.
    assert!(csv.contains('"'));
    let header_cols = csv.lines().next().unwrap().split(',').count();
    assert_eq!(header_cols, 8);
}

#[test]
fn les_guillemets_internes_sont_doubles() {
    let rows = vec![vec!["a\"b".to_string(), "simple".to_string()]];
    assert_eq!(to_csv(&rows), "\"a\"\"b\",simple");
}
