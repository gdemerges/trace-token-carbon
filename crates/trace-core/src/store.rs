//! Persistance : préférences utilisateur et index d'indexation incrémentale.
//!
//! Deux exigences ont dicté l'implémentation, et elles valent toujours :
//!
//!  - Écriture atomique (fichier temporaire puis `rename`). Un rafraîchissement
//!    interrompu ne doit pas laisser un index tronqué qui ferait recompter
//!    l'historique depuis zéro — ou pire, en double.
//!  - Permissions restreintes. La configuration peut contenir des clés Admin,
//!    et l'index porte les noms de projets, les identifiants de session et la
//!    volumétrie.

use crate::collectors::{CollectorState, Event, Quota};
use crate::util::{now_ms, Tokens};
use chrono::{Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const DAY_MS: i64 = 86_400_000;

/// Emplacement des fichiers : le répertoire de configuration du système, jamais
/// le dépôt ni le dossier de l'application.
pub fn base_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("TRACE_HOME") {
        return PathBuf::from(home);
    }
    let home = crate::util::home_dir();
    #[cfg(target_os = "macos")]
    {
        home.join("Library").join("Application Support").join("TRACE")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("TRACE")
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("trace")
    }
}

/// Le dossier est en 0700, et pas seulement les fichiers qu'il contient.
///
/// Sur macOS il hérite du 0700 posé par le système, ce qui masquait le
/// problème ; sous Linux (`~/.config/trace`) le mode par défaut donne 0755, et
/// l'index — qui porte le nom de tous vos projets, vos identifiants de session
/// et votre volumétrie — devenait lisible par n'importe quel compte.
pub fn ensure_dir() -> PathBuf {
    let dir = base_dir();
    let _ = fs::create_dir_all(&dir);
    #[cfg(unix)]
    {
        // Un dossier créé par une version antérieure garde son mode : on le
        // resserre au passage plutôt que d'attendre une réinstallation.
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    dir
}

pub fn config_path() -> PathBuf {
    ensure_dir().join("config.json")
}
pub fn index_path() -> PathBuf {
    ensure_dir().join("index.json")
}
pub fn owner_path() -> PathBuf {
    ensure_dir().join("owner.json")
}

/// Écriture atomique : fichier temporaire, permissions, puis `rename`.
fn write_atomic(file: &PathBuf, data: &str, _mode: u32) -> std::io::Result<()> {
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&tmp, data)?;
    #[cfg(unix)]
    fs::set_permissions(&tmp, fs::Permissions::from_mode(_mode))?;
    fs::rename(&tmp, file)
}

fn read_json<T: for<'de> Deserialize<'de>>(file: &PathBuf) -> Option<T> {
    let text = fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CarbonConfig {
    pub grid_key: String,
    pub local_grid_key: String,
    pub pue: Option<f64>,
}

/// Provenance d'une limite calibrée à la main.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LimitMeta {
    /// `user` quand l'utilisateur a saisi un pourcentage relevé par `/usage`.
    pub source: Option<String>,
    pub at: Option<i64>,
    pub from_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlertsConfig {
    pub enabled: bool,
    pub thresholds: Vec<f64>,
    pub projection: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u32,
    // --- Sources ---
    pub disabled_sources: Vec<String>,
    pub anthropic_admin_key: Option<String>,
    pub openai_admin_key: Option<String>,
    pub api_lookback_days: i64,
    // --- Carbone ---
    pub carbon: CarbonConfig,
    /// Limites connues de l'utilisateur, en tokens pondérés. Absent = calibrage
    /// automatique.
    pub limits: HashMap<String, f64>,
    /// D'où vient chaque limite, et quand elle a été posée. Séparé de
    /// `limits` pour que celui-ci reste une table de nombres, lisible et
    /// modifiable à la main.
    pub limit_meta: HashMap<String, LimitMeta>,
    pub alerts: AlertsConfig,
    // --- Interface ---
    /// `auto` suit la langue du système ; `fr` ou `en` la forcent.
    pub locale: String,
    pub shortcut: String,
    pub launch_at_login: bool,
    /// Un appel au démarrage puis une fois par jour, pour savoir si une version
    /// corrigée existe. Rien n'est téléchargé ni exécuté ; `false` supprime
    /// tout appel.
    pub check_updates: bool,
    pub refresh_interval_sec: u64,
    pub tray_metric: String,
    pub currency: String,
    pub default_range_days: i64,
    /// Assez large pour ne jamais élaguer avant les outils eux-mêmes : Claude
    /// Code purge ses sessions au bout de deux mois environ, Codex garde ses
    /// rollouts bien plus longtemps. C'est la source qui doit limiter
    /// l'historique, pas TRACE.
    pub retention_days: i64,
    /// Au-delà de cette ancienneté, les événements sont repliés en agrégats
    /// horaires. Zéro désactive la compaction.
    pub compact_after_days: i64,
    pub model_overrides: HashMap<String, crate::models::ModelOverride>,
    /// Posé par l'appelant quand il sait ne pas être le processus écrivain.
    #[serde(skip)]
    pub read_only: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            disabled_sources: Vec::new(),
            anthropic_admin_key: None,
            openai_admin_key: None,
            api_lookback_days: 30,
            carbon: CarbonConfig {
                grid_key: "us-average".into(),
                local_grid_key: "france".into(),
                pue: None,
            },
            limits: HashMap::new(),
            limit_meta: HashMap::new(),
            alerts: AlertsConfig { enabled: true, thresholds: vec![80.0, 95.0], projection: true },
            locale: "auto".into(),
            shortcut: "CommandOrControl+Alt+T".into(),
            launch_at_login: false,
            check_updates: true,
            refresh_interval_sec: 60,
            tray_metric: "session".into(),
            currency: "USD".into(),
            default_range_days: 30,
            retention_days: 1095,
            compact_after_days: 90,
            model_overrides: HashMap::new(),
            read_only: false,
        }
    }
}

/// Charge la configuration, chaque champ absent prenant sa valeur par défaut.
pub fn load_config() -> Config {
    read_json::<Config>(&config_path()).unwrap_or_default()
}

pub fn save_config(config: &Config) -> std::io::Result<()> {
    // 0600 : la configuration peut contenir des clés Admin.
    let json = serde_json::to_string_pretty(config).unwrap_or_else(|_| "{}".into());
    write_atomic(&config_path(), &json, 0o600)
}

// ---------------------------------------------------------------------------
// Propriété de l'index
// ---------------------------------------------------------------------------

/// Un seul processus écrit l'index à la fois.
///
/// L'application et la CLI partagent le même fichier, et toutes deux le
/// relisent, le complètent, puis le réécrivent en entier. Lancer `trace`
/// pendant que l'application tourne faisait s'écraser mutuellement les offsets
/// des collecteurs : la déduplication protégeait les chiffres, mais chaque
/// processus repartait ensuite en relecture complète.
///
/// Un verrou par fichier ne suffirait pas : la fenêtre à protéger n'est pas
/// l'écriture — atomique, quelques millisecondes — mais tout le cycle
/// lecture → collecte → écriture. On désigne donc un propriétaire, qui
/// rafraîchit sa marque à chaque cycle. Les autres lisent l'index sans
/// l'écrire : ils affichent des chiffres justes sans rien dégrader.
pub const OWNER_STALE_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Owner {
    pid: u32,
    at: i64,
}

/// Se déclare propriétaire de l'index. L'application appelle ceci à chaque cycle.
pub fn claim_ownership(now: i64) -> bool {
    let owner = Owner { pid: std::process::id(), at: now };
    let json = serde_json::to_string(&owner).unwrap_or_default();
    write_atomic(&owner_path(), &json, 0o600).is_ok()
}

/// Vrai si un AUTRE processus, toujours vivant, tient l'index.
pub fn owned_by_another(now: i64) -> bool {
    let Some(owner) = read_json::<Owner>(&owner_path()) else {
        return false;
    };
    if owner.pid == std::process::id() {
        return false;
    }
    // Marque périmée : le propriétaire a été tué sans relâcher. On ne va pas
    // condamner l'index pour autant.
    if now - owner.at >= OWNER_STALE_MS {
        return false;
    }
    process_alive(owner.pid)
}

/// Le processus existe-t-il encore ?
///
/// Sous Unix, le signal 0 ne tue rien et vérifie seulement l'existence ;
/// `EPERM` signifie que le processus est là mais appartient à un autre
/// utilisateur, ce qui compte comme vivant.
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if r == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    // Faute d'un équivalent portable en bibliothèque standard, on interroge le
    // système. Un échec de la commande vaut « vivant » : mieux vaut renoncer à
    // écrire que risquer d'écraser l'index d'un processus actif.
    match std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()),
        Err(_) => true,
    }
}

pub fn release_ownership() {
    if let Some(owner) = read_json::<Owner>(&owner_path()) {
        if owner.pid == std::process::id() {
            let _ = fs::remove_file(owner_path());
        }
    }
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Index {
    pub version: u32,
    pub updated_at: i64,
    pub retention_days: i64,
    pub compact_after_days: i64,
    /// Frontière du détail : en deçà, l'index ne porte plus que des agrégats
    /// horaires, et toute requête unitaire relue à nouveau doit être ignorée.
    pub compacted_through: i64,
    pub collectors: HashMap<String, CollectorState>,
    pub events: Vec<Event>,
    pub quota: Vec<Quota>,
    /// Le dernier relevé direct et son éventuel report, persistés pour qu'un
    /// redémarrage ne refrappe pas l'API et n'hérite pas d'une attente muette.
    #[serde(default)]
    pub live: crate::collectors::anthropic_oauth::LiveState,
    /// Signalé à l'appelant quand la rétention a été élargie et que les offsets
    /// ont été remis à zéro. Non persisté.
    #[serde(skip)]
    pub reindexed: bool,
}

pub const INDEX_VERSION: u32 = 2;

fn empty_index() -> Index {
    Index { version: INDEX_VERSION, ..Index::default() }
}

pub fn load_index(config: &Config) -> Index {
    let Some(idx) = read_json::<Index>(&index_path()) else {
        return empty_index();
    };
    if idx.version != INDEX_VERSION {
        return empty_index();
    }

    // Rétention élargie : l'historique élagué ne reviendra pas tout seul, les
    // collecteurs reprenant leur lecture à un offset. On remet les offsets à
    // zéro pour forcer une relecture complète — quelques centaines de
    // millisecondes, c'est indolore.
    if idx.retention_days < config.retention_days {
        return Index {
            version: INDEX_VERSION,
            collectors: HashMap::new(),
            events: idx.events,
            quota: idx.quota,
            live: idx.live,
            // La relecture complète repasserait sur des périodes déjà
            // repliées : la borne de compaction voyage avec l'index pour que
            // la fusion sache écarter ce détail redevenu inutile.
            compacted_through: idx.compacted_through,
            reindexed: true,
            ..Index::default()
        };
    }
    idx
}

pub struct Compacted {
    pub events: Vec<Event>,
    pub compacted_through: i64,
    pub folded: usize,
}

/// Replie les événements anciens en agrégats HORAIRES.
///
/// L'index conserve un enregistrement par requête sur toute la rétention —
/// trois ans par défaut. Or au-delà de quelques semaines, plus aucune vue ne
/// consomme la requête unitaire : série journalière, histogramme horaire,
/// ventilations par modèle et par projet passent toutes par une agrégation.
/// Garder le détail revient à relire et réécrire des dizaines de mégaoctets
/// pour une information que personne ne regarde.
///
/// Pourquoi l'HEURE et non le jour : mesuré sur un index réel, replier à
/// l'heure divise le volume par 46, replier au jour par 98. Le facteur deux
/// gagné coûterait l'histogramme horaire — la vue qui montre les rythmes de
/// travail — et la précision de la série journalière aux frontières de fuseau.
///
/// Ce qui est perdu, et assumé : la session. Un agrégat horaire recouvre
/// plusieurs sessions, on n'en retient donc aucune plutôt que d'en inventer
/// une.
pub fn compact(events: Vec<Event>, older_than_days: i64, now: i64, fallback_through: i64) -> Compacted {
    if older_than_days <= 0 {
        return Compacted { events, compacted_through: fallback_through, folded: 0 };
    }
    let cutoff = now - older_than_days * DAY_MS;
    let mut recent = Vec::new();
    let mut buckets: HashMap<String, Event> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut folded = 0usize;

    for e in events {
        // Un agrégat journalier est déjà replié : le repasser à la moulinette
        // horaire le déplacerait à minuit sans rien gagner.
        if e.ts >= cutoff || e.compacted.as_deref() == Some("day") {
            recent.push(e);
            continue;
        }
        let hour = Local
            .timestamp_millis_opt(e.ts)
            .single()
            .and_then(|d| d.with_minute(0))
            .and_then(|d| d.with_second(0))
            .and_then(|d| d.with_nanosecond(0))
            .map(|d| d.timestamp_millis())
            .unwrap_or(e.ts);
        let key = format!(
            "{hour}\u{0}{}\u{0}{}\u{0}{}",
            e.source,
            e.model,
            e.project.as_deref().unwrap_or("")
        );

        match buckets.get_mut(&key) {
            Some(b) => {
                folded += 1;
                b.tokens.add(&e.tokens);
                b.requests += if e.requests != 0 { e.requests } else { 1 };
            }
            None => {
                order.push(key.clone());
                buckets.insert(
                    key,
                    Event {
                        ts: hour,
                        source: e.source,
                        model: e.model,
                        project: e.project,
                        session: None,
                        tokens: e.tokens,
                        requests: if e.requests != 0 { e.requests } else { 1 },
                        compacted: Some("hour".to_string()),
                    },
                );
            }
        }
    }

    let mut all: Vec<Event> = if order.is_empty() {
        recent
    } else {
        let mut compacted: Vec<Event> =
            order.into_iter().filter_map(|k| buckets.remove(&k)).collect();
        compacted.extend(recent);
        compacted.sort_by_key(|e| e.ts);
        compacted
    };
    all.shrink_to_fit();
    Compacted { events: all, compacted_through: cutoff, folded }
}

/// Signature bon marché de l'état persistable.
///
/// L'index était réécrit à chaque cycle de 60 s même sans le moindre nouvel
/// événement : 2 Mo × 1440, près de 3 Go écrits par jour pour une application
/// au repos. Ce n'est pas un problème de vitesse — quelques millisecondes —
/// mais d'usure du disque et d'E/S sans objet.
pub fn index_signature(idx: &Index, retention_days: i64) -> String {
    let last = |v: &[Event]| v.last().map(|e| e.ts).unwrap_or(0);
    let last_q = |v: &[Quota]| v.last().map(|q| q.ts).unwrap_or(0);
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        retention_days,
        idx.events.len(),
        last(&idx.events),
        idx.quota.len(),
        last_q(&idx.quota),
        idx.compacted_through,
        // Les offsets des collecteurs changent dès qu'un fichier grossit, même
        // si aucune ligne exploitable n'en sort.
        serde_json::to_string(&idx.collectors).map(|s| s.len()).unwrap_or(0)
    )
}

/// Cache de processus : ce qui a été écrit la dernière fois.
static LAST_SIGNATURE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Réservé aux tests : la signature est un cache de processus.
pub fn reset_signature() {
    if let Ok(mut s) = LAST_SIGNATURE.lock() {
        *s = None;
    }
}

/// Élague, replie, puis écrit — si nous sommes bien le processus qui écrit.
///
/// Rend l'index RETENU : c'est lui, et pas celui d'avant élagage, que
/// l'appelant doit garder en mémoire, sous peine de voir la vue et le fichier
/// diverger au prochain démarrage.
pub fn save_index(idx: Index, config: &Config) -> Index {
    let now = now_ms();
    let cutoff = now - config.retention_days * DAY_MS;

    let kept: Vec<Event> = idx.events.into_iter().filter(|e| e.ts >= cutoff).collect();
    let folded = compact(kept, config.compact_after_days, now, idx.compacted_through);

    let trimmed = Index {
        version: INDEX_VERSION,
        updated_at: now,
        // Mémorisée pour détecter un élargissement : les événements déjà
        // élagués ne reviendraient pas d'eux-mêmes, il faut relire les sources.
        retention_days: config.retention_days,
        compact_after_days: config.compact_after_days,
        compacted_through: idx.compacted_through.max(folded.compacted_through),
        collectors: idx.collectors,
        events: folded.events,
        quota: idx.quota.into_iter().filter(|q| q.ts >= cutoff).collect(),
        live: idx.live,
        reindexed: false,
    };

    let signature = index_signature(&trimmed, config.retention_days);
    {
        let Ok(last) = LAST_SIGNATURE.lock() else { return trimmed };
        if last.as_deref() == Some(signature.as_str()) {
            return trimmed; // rien n'a bougé
        }
    }
    // Un autre processus tient l'index : on lui laisse la main. Nos chiffres
    // restent justes en mémoire, on cesse simplement de réécrire par-dessus.
    if config.read_only || owned_by_another(now) {
        return trimmed;
    }
    // 0600 comme la configuration : l'index porte l'historique d'usage, les
    // noms de projets et les identifiants de session.
    let json = serde_json::to_string(&trimmed).unwrap_or_else(|_| "{}".into());
    if write_atomic(&index_path(), &json, 0o600).is_ok() {
        if let Ok(mut last) = LAST_SIGNATURE.lock() {
            *last = Some(signature);
        }
    }
    trimmed
}

/// Somme de tokens vide, exposée pour les appelants qui construisent un index
/// à la main.
pub fn empty_tokens() -> Tokens {
    Tokens::empty()
}
