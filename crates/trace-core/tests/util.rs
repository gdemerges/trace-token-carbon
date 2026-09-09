//! Lecture incrémentale et structure de tokens.
//!
//! La lecture incrémentale est le point le plus délicat du portage : Claude
//! Code écrit dans les journaux PENDANT qu'on les lit, et une reprise mal
//! placée fait soit perdre un enregistrement, soit le compter deux fois.

use std::io::Write;
use trace_core::util::{day_key, project_name, read_jsonl_from, since, Tokens};

fn tmp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("trace-rs-{}-{}", name, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &std::path::Path, bytes: &[u8]) {
    let mut f = std::fs::File::create(path).unwrap();
    f.write_all(bytes).unwrap();
}

fn append(path: &std::path::Path, bytes: &[u8]) {
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    f.write_all(bytes).unwrap();
}

#[test]
fn le_total_n_est_jamais_recalcule_a_partir_des_parties() {
    // Le fournisseur seul sait ce qu'il a facturé. Déduire `total` d'une somme
    // recompterait les tokens de cache, déjà présents dans leurs champs.
    let mut acc = Tokens::empty();
    acc.add(&Tokens {
        input: 10,
        cache_read: 100,
        total: 110,
        ..Tokens::empty()
    });
    acc.add(&Tokens {
        input: 5,
        cache_read: 50,
        total: 55,
        ..Tokens::empty()
    });
    assert_eq!(acc.total, 165);
    assert_eq!(acc.input, 15);
    assert_eq!(acc.cache_read, 150);
}

#[test]
fn une_ligne_incomplete_est_relue_entiere_a_la_passe_suivante() {
    let dir = tmp("incomplete");
    let file = dir.join("a.jsonl");
    write(&file, b"{\"n\":1}\n{\"n\":2}\n{\"n\":3");

    let mut seen = Vec::new();
    let r1 = read_jsonl_from(&file, 0, |v| seen.push(v["n"].as_i64().unwrap()));
    assert!(r1.ok);
    assert_eq!(
        seen,
        vec![1, 2],
        "la ligne tronquée ne doit pas être livrée"
    );

    // Le producteur termine la ligne, puis en écrit une autre.
    append(&file, b"}\n{\"n\":4}\n");
    let mut seen2 = Vec::new();
    let r2 = read_jsonl_from(&file, r1.offset, |v| seen2.push(v["n"].as_i64().unwrap()));
    assert!(r2.ok);
    assert_eq!(seen2, vec![3, 4], "ni perdue, ni comptée deux fois");
}

#[test]
fn un_fichier_tronque_repart_du_debut() {
    let dir = tmp("tronque");
    let file = dir.join("b.jsonl");
    write(&file, b"{\"n\":1}\n{\"n\":2}\n");
    let r1 = read_jsonl_from(&file, 0, |_| {});

    // Rotation du journal : le fichier rapetisse. L'offset d'avant ne veut
    // plus rien dire, et lire à partir de lui sauterait le nouveau contenu.
    write(&file, b"{\"n\":9}\n");
    let mut seen = Vec::new();
    let r2 = read_jsonl_from(&file, r1.offset, |v| seen.push(v["n"].as_i64().unwrap()));
    assert!(r2.ok);
    assert_eq!(seen, vec![9]);
}

#[test]
fn une_ligne_corrompue_ne_casse_pas_l_indexation() {
    let dir = tmp("corrompue");
    let file = dir.join("c.jsonl");
    write(&file, b"{\"n\":1}\npas du json\n\n{\"n\":2}\n");
    let mut seen = Vec::new();
    let r = read_jsonl_from(&file, 0, |v| seen.push(v["n"].as_i64().unwrap()));
    assert!(r.ok);
    assert_eq!(
        seen,
        vec![1, 2],
        "les lignes saines de part et d'autre passent"
    );
}

#[test]
fn un_caractere_multi_octets_coupe_par_la_frontiere_de_lecture_survit() {
    // Le découpage se fait sur les octets, précisément pour ce cas : « é »
    // s'écrit sur deux octets, et une lecture qui s'arrête entre les deux
    // planterait un caractère de remplacement si on décodait avant de couper.
    let dir = tmp("utf8");
    let file = dir.join("d.jsonl");
    let complete = "{\"p\":\"éàü\"}\n".as_bytes().to_vec();
    // On coupe au milieu du « é ».
    write(&file, &complete[..complete.len() - 6]);
    let mut seen: Vec<String> = Vec::new();
    let r1 = read_jsonl_from(&file, 0, |v| seen.push(v["p"].as_str().unwrap().into()));
    assert!(seen.is_empty(), "rien de complet à livrer");

    write(&file, &complete);
    let r2 = read_jsonl_from(&file, r1.offset, |v| {
        seen.push(v["p"].as_str().unwrap().into())
    });
    assert!(r2.ok);
    assert_eq!(seen, vec!["éàü".to_string()]);
}

#[test]
fn un_fichier_inchange_se_signale_sans_relire() {
    let dir = tmp("inchange");
    let file = dir.join("e.jsonl");
    write(&file, b"{\"n\":1}\n");
    let r1 = read_jsonl_from(&file, 0, |_| {});
    let mut count = 0;
    let r2 = read_jsonl_from(&file, r1.offset, |_| count += 1);
    assert!(r2.unchanged);
    assert_eq!(count, 0);
}

#[test]
fn un_fichier_absent_ne_fait_pas_reculer_l_offset() {
    let r = read_jsonl_from(
        std::path::Path::new("/introuvable/nulle/part.jsonl"),
        42,
        |_| {},
    );
    assert!(!r.ok);
    assert_eq!(
        r.offset, 42,
        "un balayage raté ne doit pas provoquer un recomptage"
    );
}

#[test]
fn la_cle_de_jour_est_locale_et_zero_padded() {
    // Format stable `YYYY-MM-DD` : c'est une clé d'agrégation, elle est triée
    // comme du texte.
    let k = day_key(0);
    assert_eq!(k.len(), 10);
    assert_eq!(k.as_bytes()[4], b'-');
    assert_eq!(k.as_bytes()[7], b'-');
}

#[test]
fn le_nom_de_projet_est_le_dernier_segment() {
    assert_eq!(project_name("/Users/x/Dev/Trace").as_deref(), Some("Trace"));
    assert_eq!(project_name(""), None);
}

#[test]
fn la_fenetre_glissante_recule_du_bon_nombre_d_heures() {
    assert_eq!(since(5.0, 10_000_000), 10_000_000 - 18_000_000);
}
