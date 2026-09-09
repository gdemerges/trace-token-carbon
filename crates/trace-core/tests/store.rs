//! Persistance : configuration, index, compaction, propriété.
//!
//! Tous ces tests écrivent dans un répertoire jetable désigné par `TRACE_HOME`.
//! Ils tournent donc en série — la variable est globale au processus — d'où le
//! verrou partagé plutôt qu'un `#[test]` naïf par cas.

use std::sync::{Mutex, MutexGuard};
use trace_core::collectors::{Event, Quota};
use trace_core::store::{self, Config};
use trace_core::util::Tokens;

static SERIAL: Mutex<()> = Mutex::new(());

struct Sandbox {
    dir: std::path::PathBuf,
    _guard: MutexGuard<'static, ()>,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("trace-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("TRACE_HOME", &dir);
        store::reset_signature();
        Sandbox { dir, _guard: guard }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        std::env::remove_var("TRACE_HOME");
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const DAY_MS: i64 = 86_400_000;

fn event(ts: i64, total: i64) -> Event {
    Event {
        ts,
        source: "claude-code".into(),
        model: "claude-sonnet-4-5".into(),
        project: Some("trace".into()),
        session: Some(format!("s-{ts}")),
        tokens: Tokens { input: total, total, ..Tokens::empty() },
        requests: 1,
        compacted: None,
    }
}

fn index_with(events: Vec<Event>) -> store::Index {
    store::Index { version: 2, events, ..store::Index::default() }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[test]
fn une_configuration_absente_rend_les_valeurs_par_defaut() {
    let _s = Sandbox::new("cfg-defaut");
    let c = store::load_config();
    assert_eq!(c.retention_days, 1095);
    assert_eq!(c.carbon.grid_key, "us-average");
    assert!(c.alerts.enabled);
}

#[test]
fn un_champ_absent_du_fichier_reprend_son_defaut() {
    let _s = Sandbox::new("cfg-partiel");
    // Une configuration écrite par une version antérieure n'a pas les champs
    // ajoutés depuis. Elle doit rester lisible, pas réinitialiser le reste.
    std::fs::write(store::config_path(), r#"{"shortcut":"Ctrl+Shift+Y","currency":"EUR"}"#).unwrap();
    let c = store::load_config();
    assert_eq!(c.shortcut, "Ctrl+Shift+Y");
    assert_eq!(c.currency, "EUR");
    assert_eq!(c.retention_days, 1095, "le reste garde ses défauts");
    assert!(c.check_updates);
}

#[test]
fn la_configuration_fait_l_aller_retour_sans_perte() {
    let _s = Sandbox::new("cfg-roundtrip");
    let mut c = Config::default();
    c.anthropic_admin_key = Some("sk-ant-admin-factice".into());
    c.carbon.pue = Some(1.15);
    c.alerts.thresholds = vec![50.0, 75.0, 90.0];
    store::save_config(&c).unwrap();

    let back = store::load_config();
    assert_eq!(back.anthropic_admin_key.as_deref(), Some("sk-ant-admin-factice"));
    assert_eq!(back.carbon.pue, Some(1.15));
    assert_eq!(back.alerts.thresholds, vec![50.0, 75.0, 90.0]);
}

#[cfg(unix)]
#[test]
fn dossier_en_0700_index_et_configuration_en_0600() {
    use std::os::unix::fs::PermissionsExt;
    let _s = Sandbox::new("perms");
    store::save_config(&Config::default()).unwrap();
    store::save_index(index_with(vec![event(trace_core::util::now_ms(), 10)]), &Config::default());

    let mode = |p: std::path::PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(store::base_dir()), 0o700, "l'index ne doit pas être lisible par les autres comptes");
    assert_eq!(mode(store::config_path()), 0o600);
    assert_eq!(mode(store::index_path()), 0o600, "il porte les noms de projets et les sessions");
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

#[test]
fn la_compaction_replie_a_l_heure_et_conserve_les_totaux() {
    let now = trace_core::util::now_ms();
    let old = now - 200 * DAY_MS;
    // Trois requêtes dans la même heure, plus une récente.
    let events = vec![event(old, 100), event(old + 60_000, 50), event(old + 120_000, 25), event(now, 7)];
    let r = store::compact(events, 90, now, 0);

    assert_eq!(r.events.len(), 2, "les trois anciennes se replient en une");
    assert_eq!(r.folded, 2);
    let folded = r.events.iter().find(|e| e.compacted.as_deref() == Some("hour")).unwrap();
    assert_eq!(folded.tokens.total, 175, "aucun token ne doit disparaître au repli");
    assert_eq!(folded.requests, 3);
    assert_eq!(folded.session, None, "un agrégat horaire recouvre plusieurs sessions : aucune n'est inventée");
}

#[test]
fn la_compaction_desactivee_ne_fait_rien() {
    let now = trace_core::util::now_ms();
    let events = vec![event(now - 500 * DAY_MS, 100)];
    assert_eq!(store::compact(events, 0, now, 0).events.len(), 1);
}

#[test]
fn un_agregat_deja_replie_n_est_pas_replie_une_seconde_fois() {
    let now = trace_core::util::now_ms();
    let mut already = event(now - 300 * DAY_MS, 500);
    already.compacted = Some("day".into());
    already.session = None;
    let r = store::compact(vec![already], 90, now, 0);
    assert_eq!(r.events[0].compacted.as_deref(), Some("day"), "un repli journalier reste journalier");
    assert_eq!(r.events[0].tokens.total, 500);
}

#[test]
fn les_evenements_replies_restent_tries_dans_le_temps() {
    let now = trace_core::util::now_ms();
    let events = vec![event(now, 1), event(now - 300 * DAY_MS, 2), event(now - 100 * DAY_MS, 3)];
    let r = store::compact(events, 90, now, 0);
    let mut sorted = r.events.iter().map(|e| e.ts).collect::<Vec<_>>();
    let original = sorted.clone();
    sorted.sort();
    assert_eq!(original, sorted, "la série journalière lit cet ordre");
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

#[test]
fn la_retention_elague_et_l_index_rendu_est_celui_qu_il_faut_garder() {
    let _s = Sandbox::new("retention");
    let now = trace_core::util::now_ms();
    let config = Config { retention_days: 30, compact_after_days: 0, ..Config::default() };
    let idx = index_with(vec![event(now - 400 * DAY_MS, 10), event(now, 20)]);

    let saved = store::save_index(idx, &config);
    assert_eq!(saved.events.len(), 1, "l'ancien événement est élagué");
    assert_eq!(saved.events[0].tokens.total, 20);
    // C'est bien l'index élagué qui est rendu : garder l'autre en mémoire
    // ferait diverger la vue et le fichier au prochain démarrage.
    assert_eq!(store::load_index(&config).events.len(), 1);
}

#[test]
fn un_elargissement_de_retention_force_une_relecture_complete() {
    let _s = Sandbox::new("elargissement");
    let now = trace_core::util::now_ms();
    let narrow = Config { retention_days: 30, compact_after_days: 0, ..Config::default() };
    let mut idx = index_with(vec![event(now, 20)]);
    idx.collectors.insert("claude-code".into(), Default::default());
    store::save_index(idx, &narrow);

    // L'historique élagué ne reviendra pas tout seul : les collecteurs
    // reprennent à un offset. Il faut remettre les offsets à zéro.
    let wide = Config { retention_days: 365, ..narrow.clone() };
    let reloaded = store::load_index(&wide);
    assert!(reloaded.reindexed);
    assert!(reloaded.collectors.is_empty(), "les offsets doivent repartir de zéro");
    assert_eq!(reloaded.events.len(), 1, "les événements déjà connus sont conservés");
}

#[test]
fn une_signature_inchangee_evite_de_reecrire() {
    let _s = Sandbox::new("signature");
    let now = trace_core::util::now_ms();
    let config = Config { compact_after_days: 0, ..Config::default() };
    store::save_index(index_with(vec![event(now, 10)]), &config);
    let first = std::fs::metadata(store::index_path()).unwrap().len();

    // Rien n'a bougé : 2 Mo réécrits toutes les 60 s pour rien, c'est de
    // l'usure de disque, pas un problème de vitesse.
    let before = std::fs::read(store::index_path()).unwrap();
    store::save_index(index_with(vec![event(now, 10)]), &config);
    let after = std::fs::read(store::index_path()).unwrap();
    assert_eq!(before, after);
    assert_eq!(first, after.len() as u64);
}

// ---------------------------------------------------------------------------
// Propriété de l'index
// ---------------------------------------------------------------------------

/// Un processus assurément vivant, et assurément différent du nôtre.
///
/// Le PID 1 servait à cela côté JS. C'est vrai sous Unix, où init ne meurt
/// jamais ; Windows n'a pas d'init, et le test s'y trompait de conclusion.
fn alive_pid() -> u32 {
    parent_pid()
}

#[cfg(unix)]
fn parent_pid() -> u32 {
    unsafe { libc::getppid() as u32 }
}

#[cfg(not(unix))]
fn parent_pid() -> u32 {
    std::process::id()
}

fn mark_owner(pid: u32, at: i64) {
    std::fs::write(store::owner_path(), format!(r#"{{"pid":{pid},"at":{at}}}"#)).unwrap();
}

#[test]
fn notre_propre_marque_ne_nous_bloque_pas() {
    let _s = Sandbox::new("prop-self");
    let now = trace_core::util::now_ms();
    store::claim_ownership(now);
    assert!(!store::owned_by_another(now));
}

#[cfg(unix)]
#[test]
fn une_marque_fraiche_d_un_processus_vivant_nous_met_en_lecture_seule() {
    let _s = Sandbox::new("prop-vivant");
    let now = trace_core::util::now_ms();
    mark_owner(alive_pid(), now);
    assert!(store::owned_by_another(now));
}

#[test]
fn une_marque_perimee_ne_condamne_pas_l_index() {
    let _s = Sandbox::new("prop-perime");
    let now = trace_core::util::now_ms();
    mark_owner(parent_pid(), now - store::OWNER_STALE_MS - 1000);
    assert!(!store::owned_by_another(now), "un propriétaire tué sans relâcher ne bloque pas à vie");
}

#[test]
fn un_processus_mort_ne_condamne_pas_l_index() {
    let _s = Sandbox::new("prop-mort");
    let now = trace_core::util::now_ms();
    // Un PID hors de portée du système : introuvable, donc sans propriétaire.
    mark_owner(0x7fff_fffe, now);
    assert!(!store::owned_by_another(now));
}

#[cfg(unix)]
#[test]
fn un_second_processus_n_ecrase_pas_l_index_du_premier() {
    let _s = Sandbox::new("prop-ecrasement");
    let now = trace_core::util::now_ms();
    let config = Config { compact_after_days: 0, ..Config::default() };
    let mut first = index_with(vec![event(now, 10)]);
    first.collectors.insert("a".into(), Default::default());
    store::save_index(first, &config);
    let written = std::fs::read(store::index_path()).unwrap();

    // Un autre processus tient désormais la marque.
    mark_owner(alive_pid(), now);
    store::reset_signature();
    let result = store::save_index(index_with(vec![]), &config);

    assert_eq!(std::fs::read(store::index_path()).unwrap(), written, "le fichier du propriétaire est intact");
    assert_eq!(result.version, 2, "l'appelant reçoit tout de même son index élagué, en mémoire");
}

#[test]
fn read_only_suffit_a_empecher_toute_ecriture() {
    let _s = Sandbox::new("prop-readonly");
    let config = Config { read_only: true, ..Config::default() };
    store::save_index(index_with(vec![]), &config);
    assert!(!store::index_path().exists());
}

#[test]
fn relacher_la_propriete_efface_notre_marque_et_pas_celle_d_un_autre() {
    let _s = Sandbox::new("prop-release");
    let now = trace_core::util::now_ms();
    store::claim_ownership(now);
    store::release_ownership();
    assert!(!store::owner_path().exists());

    mark_owner(0x7fff_fffe, now);
    store::release_ownership();
    assert!(store::owner_path().exists(), "on n'efface pas la marque d'un autre processus");
}

#[test]
fn un_quota_trop_ancien_est_elague_comme_les_evenements() {
    let _s = Sandbox::new("quota-retention");
    let now = trace_core::util::now_ms();
    let config = Config { retention_days: 30, compact_after_days: 0, ..Config::default() };
    let mut idx = index_with(vec![event(now, 5)]);
    idx.quota = vec![
        Quota { source: "claude-code".into(), ts: now - 400 * DAY_MS, kind: "five_hour".into(), status: None, resets_at: 0, using_overage: false, cause: trace_core::collectors::Cause::Unknown, used_percent: None, window_minutes: None, plan: None },
        Quota { source: "claude-code".into(), ts: now, kind: "five_hour".into(), status: None, resets_at: 0, using_overage: false, cause: trace_core::collectors::Cause::Unknown, used_percent: None, window_minutes: None, plan: None },
    ];
    let saved = store::save_index(idx, &config);
    assert_eq!(saved.quota.len(), 1);
}
