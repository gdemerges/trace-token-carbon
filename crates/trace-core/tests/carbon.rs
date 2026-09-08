//! Empreinte carbone — portage des intentions qui gardaient déjà la version
//! Electron, plus les invariants que le portage lui-même met en jeu.

use trace_core::carbon::{self, factors, Options, Pair};
use trace_core::models::{param_profile, resolve_model, Confidence, Model, ParamProfile, Range};
use trace_core::util::Tokens;

fn tk(input: i64, output: i64, cache_read: i64, cache_write: i64) -> Tokens {
    Tokens { input, output, cache_read, cache_write, ..Tokens::empty() }
}

fn opus() -> Model {
    resolve_model("claude-opus-5", None)
}

fn est(t: Tokens, m: &Model) -> carbon::Estimate {
    carbon::estimate(&t, m, &Options::default())
}

#[test]
fn la_fourchette_est_ordonnee_et_le_median_est_dedans() {
    let e = est(tk(5000, 800, 0, 0), &opus());
    assert!(e.grams_co2e.min < e.grams_co2e.max);
    assert!(e.grams_co2e.mid >= e.grams_co2e.min && e.grams_co2e.mid <= e.grams_co2e.max);
}

#[test]
fn aucun_token_consomme_aucune_empreinte() {
    let e = est(tk(0, 0, 0, 0), &opus());
    assert_eq!(e.grams_co2e.max, 0.0);
    assert_eq!(e.energy_wh.max, 0.0);
}

#[test]
fn croissance_monotone_avec_le_volume() {
    let m = resolve_model("claude-sonnet-5", None);
    let a = est(tk(0, 1000, 0, 0), &m).grams_co2e.mid;
    let b = est(tk(0, 2000, 0, 0), &m).grams_co2e.mid;
    assert!(b > a * 1.9 && b < a * 2.1, "doit être quasi linéaire dans le volume");
}

#[test]
fn un_token_genere_coute_bien_plus_qu_un_token_lu_en_cache() {
    let m = opus();
    let out = est(tk(0, 10_000, 0, 0), &m).grams_co2e.mid;
    let cached = est(tk(0, 0, 10_000, 0), &m).grams_co2e.mid;
    assert!(out > cached * 50.0, "sortie {out} devrait dominer le cache lu {cached}");
}

#[test]
fn regression_l_energie_gpu_n_est_pas_multipliee_par_le_nombre_de_gpu() {
    // La corrélation EcoLogits rend DÉJÀ l'énergie de l'ensemble des GPU
    // servant le modèle. Contrôle physique : à 70 Md de paramètres actifs,
    // ~7,7 mWh par token généré. Un facteur `gpu_count` parasite ferait
    // exploser ce chiffre, et c'est le genre d'erreur qu'un portage introduit
    // sans que rien ne la signale.
    let m = Model {
        id: "test".into(),
        label: "test".into(),
        provider: "anthropic".into(),
        family: "test".into(),
        pricing: None,
        context: None,
        params: ParamProfile {
            total: Range::new(140.0, 140.0),
            active: Range::new(70.0, 70.0),
            ..param_profile("claude-opus")
        },
    };
    let opts = Options { pue: Some(1.0), ..Options::default() };
    let e = carbon::estimate(&tk(0, 1000, 0, 0), &m, &opts);
    let per_token = e.energy_wh.mid / 1000.0;
    assert!(
        per_token > 0.006 && per_token < 0.012,
        "{per_token} Wh/token hors de l'ordre de grandeur attendu"
    );
}

#[test]
fn le_mix_electrique_change_le_resultat_dans_le_bon_sens() {
    let m = opus();
    let fr = carbon::estimate(
        &tk(0, 5000, 0, 0),
        &m,
        &Options { grid_key: Some("france".into()), ..Options::default() },
    );
    let world = carbon::estimate(
        &tk(0, 5000, 0, 0),
        &m,
        &Options { grid_key: Some("world".into()), ..Options::default() },
    );
    assert!(world.grams_co2e.mid > fr.grams_co2e.mid);
    assert_eq!(fr.grid_intensity, 56.0);
}

#[test]
fn les_sommes_s_additionnent_borne_a_borne() {
    let m = opus();
    let a = est(tk(0, 1000, 0, 0), &m);
    let b = est(tk(0, 2000, 0, 0), &m);
    let s = carbon::sum(&[a.clone(), b.clone()]);
    assert!((s.grams_co2e.min - (a.grams_co2e.min + b.grams_co2e.min)).abs() < 1e-9);
    assert!((s.water_l.min - (a.water_l.min + b.water_l.min)).abs() < 1e-9);
}

#[test]
fn le_pue_du_fournisseur_remplace_la_moyenne_generique() {
    let anthropic = est(tk(0, 5000, 0, 0), &opus());
    assert_eq!(anthropic.infra.key, "anthropic");
    // Un PUE forcé est un choix explicite : il resserre la borne haute au lieu
    // de se faire moyenner dans la fourchette du fournisseur.
    let forced = carbon::estimate(
        &tk(0, 5000, 0, 0),
        &opus(),
        &Options { pue: Some(1.09), ..Options::default() },
    );
    assert!(forced.energy_wh.max < anthropic.energy_wh.max);
}

#[test]
fn l_eau_suit_l_energie_et_reste_une_fourchette() {
    let m = opus();
    let a = est(tk(0, 1000, 0, 0), &m);
    let b = est(tk(0, 2000, 0, 0), &m);
    assert!(a.water_l.min > 0.0 && a.water_l.min <= a.water_l.mid && a.water_l.mid <= a.water_l.max);
    assert!((b.water_l.mid / a.water_l.mid - 2.0).abs() < 0.01, "linéaire en volume");
}

#[test]
fn un_fournisseur_inconnu_ouvre_la_fourchette_au_lieu_de_la_flatter() {
    // Le défaut ne doit jamais être l'hypothèse avantageuse : un modèle non
    // rattaché prend le mix mondial et la plage de PUE la plus large.
    let unknown = est(tk(0, 5000, 0, 0), &resolve_model("un-modele-jamais-vu", None));
    assert_eq!(unknown.grid_key, "world");
    assert_eq!(unknown.confidence, Confidence::Unknown);
    let anthropic = est(tk(0, 5000, 0, 0), &opus());
    let width = |e: &carbon::Estimate| e.grams_co2e.max / e.grams_co2e.min;
    assert!(width(&unknown) > width(&anthropic));
}

#[test]
fn la_sensibilite_au_mix_est_ordonnee_et_rapportee_a_la_reference() {
    let m = opus();
    let pairs = vec![Pair { tokens: tk(5000, 20_000, 0, 0), model: &m }];
    let opts = Options { grid_key: Some("us-average".into()), ..Options::default() };
    let rows = carbon::grid_sensitivity(&pairs, &opts);
    assert_eq!(rows.len(), 4);

    let fr = rows.iter().find(|r| r.key == "france").unwrap();
    let world = rows.iter().find(|r| r.key == "world").unwrap();
    assert!(fr.grams_co2e.mid < world.grams_co2e.mid);
    // Le rapport se lit « ce serait N fois moins en France » : sous la
    // référence us-average, la France doit être en dessous de 1 et le monde
    // au-dessus.
    assert!(fr.ratio.unwrap() < 1.0 && world.ratio.unwrap() > 1.0);
}

#[test]
fn la_decomposition_de_l_incertitude_est_triee_du_levier_le_plus_lourd() {
    let m = opus();
    let pairs = vec![Pair { tokens: tk(120_000, 8000, 5_000_000, 90_000), model: &m }];
    let levers = carbon::uncertainty(&pairs, &Options::default());
    assert!(!levers.is_empty());
    for w in levers.windows(2) {
        assert!(w[0].ratio >= w[1].ratio, "les leviers doivent être triés décroissants");
    }
    // Tous les rapports sont des amplitudes : jamais en dessous de 1.
    for l in &levers {
        assert!(l.ratio >= 1.0, "{} : rapport {} < 1", l.key, l.ratio);
    }
}

#[test]
fn effondrer_une_fourchette_prend_son_milieu_geometrique() {
    // Géométrique et non arithmétique : sur des bornes qui couvrent un ordre
    // de grandeur, la moyenne arithmétique colle à la borne haute et fausse
    // toute l'analyse de sensibilité.
    let pinned = factors::pin_range(Range::new(1.0, 100.0));
    assert!((pinned.mid - 10.0).abs() < 1e-9);
    assert_eq!(pinned.min, pinned.max);
    // Une borne nulle retombe sur l'arithmétique, faute de mieux.
    assert!((factors::pin_range(Range::new(0.0, 4.0)).mid - 2.0).abs() < 1e-9);
}

#[test]
fn les_equivalents_sont_lineaires_et_completement_definis() {
    let e = carbon::equivalents(1200.0);
    assert_eq!(e.len(), 5);
    let car = e.iter().find(|x| x.key == "car").unwrap();
    assert!((car.amount - 10.0).abs() < 1e-9, "1200 g / 120 g par km = 10 km");
    // Chaque équivalent porte sa réserve : les périmètres diffèrent, et un
    // lecteur ne doit pas pouvoir les additionner sans le savoir.
    assert!(e.iter().all(|x| !x.note.is_empty()));
}
