//! Le rapport carbone : ce qu'il doit dire, et ce qu'il ne doit pas laisser
//! passer.

use trace_core::carbon::sources::unpinned_sources;
use trace_core::collectors::Event;
use trace_core::core::{self, SnapshotOptions, State};
use trace_core::report_md::carbon_report;
use trace_core::store::{Config, Index};
use trace_core::util::Tokens;

const DAY: i64 = 86_400_000;

fn event(ts: i64, model: &str, output: i64) -> Event {
    Event {
        ts,
        source: "claude-code".into(),
        model: model.into(),
        project: None,
        session: None,
        tokens: Tokens {
            output,
            total: output,
            ..Tokens::empty()
        },
        requests: 1,
        compacted: None,
    }
}

fn report_for(events: Vec<Event>) -> String {
    trace_core::secrets::use_memory_backend();
    let now = 1_790_000_000_000;
    let state = State {
        config: Config::default(),
        index: Index::default(),
        events,
        quota: vec![],
        sources: vec![],
        live_stats: None,
        cost: None,
    };
    let snap = core::snapshot(
        &state,
        &SnapshotOptions {
            days: Some(30),
            to: Some(now),
            ..Default::default()
        },
    );
    carbon_report(&snap)
}

const NOW: i64 = 1_790_000_000_000;

#[test]
fn le_rapport_porte_une_fourchette_et_les_facteurs() {
    let md = report_for(vec![event(NOW - DAY, "claude-opus-5", 1_000_000)]);
    assert!(md.starts_with("# "), "un titre ouvre le rapport");
    // Une fourchette min / médiane / max, jamais un point unique.
    assert!(md.contains("| CO₂e |"));
    let row = md.lines().find(|l| l.starts_with("| CO₂e |")).unwrap();
    assert_eq!(
        row.matches('|').count(),
        5,
        "trois valeurs : bas, médiane, haut"
    );
    // Les trois éléments qui rendent le total contestable.
    assert!(md.contains("g/kWh"), "la sensibilité au mix électrique");
    assert!(
        md.contains("MODEL_QUANTIZATION_BITS"),
        "la table des facteurs"
    );
    assert!(md.contains("× "), "les leviers d'incertitude");
}

#[test]
fn tant_qu_une_source_n_est_pas_figee_le_rapport_le_proclame() {
    let md = report_for(vec![event(NOW - DAY, "claude-opus-5", 1_000_000)]);
    let unpinned = unpinned_sources();
    assert_eq!(
        md.contains("> **"),
        !unpinned.is_empty(),
        "l'avertissement suit exactement l'état des sources"
    );
    for s in unpinned {
        assert!(
            md.contains(s.label),
            "chaque source non figée est nommée : {}",
            s.label
        );
    }
}

#[test]
fn un_nom_de_modele_ne_casse_pas_le_tableau() {
    // Les noms viennent de journaux analysés : un `|` couperait la ligne.
    let md = report_for(vec![event(NOW - DAY, "evil|model\nsplit", 1_000_000)]);
    for line in md
        .lines()
        .filter(|l| l.starts_with("| ") && l.contains("evil"))
    {
        let unescaped = line.replace("\\|", "").matches('|').count();
        assert_eq!(unescaped, 5, "quatre colonnes, donc cinq barres : {line}");
    }
    assert!(!md.contains("evil|model"), "la barre brute a été échappée");
}

#[test]
fn sans_donnees_le_rapport_reste_un_document_valide() {
    let md = report_for(vec![]);
    assert!(md.starts_with("# "));
    assert!(md.contains("MODEL_QUANTIZATION_BITS"));
    // Cellule par cellule : « inf » seul se trouve dans « inférence ».
    for cell in md.lines().flat_map(|l| l.split('|')).map(str::trim) {
        assert!(
            !cell.starts_with("NaN") && cell != "inf" && !cell.starts_with("inf "),
            "nombre absurde dans une cellule : {cell:?}"
        );
    }
}
