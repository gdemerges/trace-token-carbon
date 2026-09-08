//! Collecteur Claude Code — les pièges du format, éprouvés un à un.

use std::io::Write;
use trace_core::collectors::{claude_code, Cause, CollectorState};

struct Sandbox(std::path::PathBuf);

impl Sandbox {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "trace-cc-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Sandbox(dir)
    }
    fn path(&self) -> Option<&str> {
        self.0.to_str()
    }
    fn write(&self, name: &str, content: &str) {
        std::fs::write(self.0.join(name), content).unwrap();
    }
    fn append(&self, name: &str, content: &str) {
        let mut f = std::fs::OpenOptions::new().append(true).open(self.0.join(name)).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn line(id: &str, output: i64) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"2026-08-01T10:00:00.000Z","cwd":"/tmp/projet","sessionId":"s1","requestId":"req_1","message":{{"id":"{id}","role":"assistant","model":"claude-opus-5","usage":{{"input_tokens":10,"output_tokens":{output},"cache_read_input_tokens":0,"cache_creation":{{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":0}}}}}}}}"#
    )
}

fn simple(id: &str) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"2026-08-01T10:00:00.000Z","cwd":"/tmp/p","sessionId":"s","message":{{"id":"{id}","role":"assistant","model":"claude-opus-5","usage":{{"input_tokens":1,"output_tokens":1}}}}}}"#
    )
}

#[test]
fn les_reecritures_de_streaming_ne_sont_comptees_qu_une_fois() {
    let s = Sandbox::new("dedup");
    // Même `message.id` écrit trois fois, comme le fait réellement Claude Code
    // au fil du streaming. Les compter doublerait la facture affichée.
    s.write(
        "session.jsonl",
        &format!("{}\n{}\n{}\n{}\n", line("msg_A", 50), line("msg_A", 50), line("msg_A", 50), line("msg_B", 70)),
    );

    let r = claude_code::collect(s.path(), &CollectorState::default());
    assert_eq!(r.events.len(), 2, "deux messages distincts attendus");
    assert_eq!(r.stats.skipped_duplicates, 2);
    assert_eq!(r.events[0].project.as_deref(), Some("projet"));
    assert_eq!(r.events[0].tokens.cache_write5m, 100);
}

#[test]
fn la_lecture_incrementale_ne_recompte_pas_l_existant() {
    let s = Sandbox::new("incremental");
    s.write("s.jsonl", &format!("{}\n{}\n", simple("a"), simple("b")));
    let first = claude_code::collect(s.path(), &CollectorState::default());
    assert_eq!(first.events.len(), 2);

    s.append("s.jsonl", &format!("{}\n", simple("c")));
    let second = claude_code::collect(s.path(), &first.state);
    assert_eq!(second.events.len(), 1, "seule la ligne ajoutée doit remonter");
}

#[test]
fn une_derniere_ligne_incomplete_est_ignoree_puis_reprise() {
    let s = Sandbox::new("partial");
    let b = simple("b");
    // Claude Code écrit pendant qu'on lit : la dernière ligne est tronquée.
    s.write("s.jsonl", &format!("{}\n{}", simple("a"), &b[..40]));
    let first = claude_code::collect(s.path(), &CollectorState::default());
    assert_eq!(first.events.len(), 1, "la ligne tronquée ne doit pas être comptée");

    // Le processus finit sa ligne : elle doit être reprise, exactement une fois.
    s.write("s.jsonl", &format!("{}\n{}\n", simple("a"), b));
    let second = claude_code::collect(s.path(), &first.state);
    assert_eq!(second.events.len(), 1);
    assert_eq!(second.events[0].tokens.total, 2);

    // Un troisième passage sans changement ne doit plus rien remonter.
    let third = claude_code::collect(s.path(), &second.state);
    assert_eq!(third.events.len(), 0);
}

#[test]
fn les_quota_limits_sont_extraits_et_convertis_en_millisecondes() {
    let s = Sandbox::new("quota");
    s.write(
        "s.jsonl",
        concat!(
            r#"{"type":"assistant","timestamp":"2026-08-31T19:55:49.913Z","sessionId":"s","error":"rate_limit","#,
            r#""quotaLimits":{"status":"rejected","resetsAt":1788220800,"rateLimitType":"five_hour","isUsingOverage":false},"#,
            r#""message":{"id":"z","role":"assistant","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}}"#,
            "\n"
        ),
    );
    let r = claude_code::collect(s.path(), &CollectorState::default());
    assert_eq!(r.quota.len(), 1);
    assert_eq!(r.quota[0].kind, "five_hour");
    assert_eq!(r.quota[0].resets_at, 1_788_220_800_000, "les secondes epoch doivent devenir des ms");
}

#[test]
fn la_cause_reelle_d_un_refus_n_est_pas_la_fenetre_citee() {
    // `rateLimitType` vaut toujours « five_hour » : il nomme la fenêtre dont on
    // rapporte la réinitialisation, pas ce qui a bloqué. Calibrer la jauge 5 h
    // sur un plafond de dépense mensuel la rendrait fausse.
    let cause = |text: &str| {
        let v: serde_json::Value = serde_json::from_str(&format!(
            r#"{{"message":{{"content":[{{"type":"text","text":"{text}"}}]}}}}"#
        ))
        .unwrap();
        claude_code::rejection_cause(&v)
    };
    assert_eq!(cause("You have exceeded your spend limit"), Cause::Spend);
    assert_eq!(cause("Credit balance too low"), Cause::Spend);
    assert_eq!(cause("You have hit your weekly limit"), Cause::Weekly);
    assert_eq!(cause("Session limit reached"), Cause::Window);
    assert_eq!(cause("Something else entirely"), Cause::Unknown);
}

#[test]
fn un_journal_sans_ventilation_de_ttl_reste_tarifable() {
    // Les versions anciennes ne portent que `cache_creation_input_tokens`.
    // Le repli l'attribue au TTL 5 minutes, sans quoi l'écriture de cache
    // disparaîtrait du coût.
    let usage: serde_json::Value =
        serde_json::from_str(r#"{"input_tokens":5,"output_tokens":2,"cache_creation_input_tokens":300}"#)
            .unwrap();
    let t = claude_code::extract_tokens(&usage);
    assert_eq!(t.cache_write, 300);
    assert_eq!(t.cache_write5m, 300);
    assert_eq!(t.cache_write1h, 0);
    assert_eq!(t.total, 5 + 2 + 300, "le total ne compte l'écriture qu'une fois");
}

#[test]
fn une_ecriture_en_ttl_une_heure_pure_ne_bascule_pas_sur_le_cinq_minutes() {
    let usage: serde_json::Value = serde_json::from_str(
        r#"{"input_tokens":0,"output_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":700}}"#,
    )
    .unwrap();
    let t = claude_code::extract_tokens(&usage);
    assert_eq!(t.cache_write, 700);
    assert_eq!(t.cache_write5m, 0, "sans quoi l'écriture serait facturée deux fois");
    assert_eq!(t.cache_write1h, 700);
}

#[test]
fn un_message_sans_consommation_ne_produit_pas_d_evenement() {
    let s = Sandbox::new("vide");
    s.write(
        "s.jsonl",
        concat!(
            r#"{"type":"assistant","timestamp":"2026-08-01T10:00:00.000Z","sessionId":"s","#,
            r#""message":{"id":"v","role":"assistant","model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0}}}"#,
            "\n"
        ),
    );
    let r = claude_code::collect(s.path(), &CollectorState::default());
    assert!(r.events.is_empty(), "un tour à zéro token n'est pas une requête à compter");
}
