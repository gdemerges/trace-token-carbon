//! Consommation Claude EN DIRECT, via l'endpoint que Claude Code interroge
//! lui-même pour sa commande `/usage`.
//!
//! Pourquoi ce collecteur existe : le taux d'occupation réel des fenêtres —
//! cinq heures, hebdomadaire — n'est stocké NULLE PART en local. Tout ce qu'on
//! peut faire à partir des journaux est une reconstruction approximative, et
//! mesurée sur un cas réel elle s'écartait d'un facteur 2,6. Le seul chiffre
//! juste est celui que le serveur renvoie.
//!
//! On réutilise les identifiants OAuth déjà présents sur la machine, ceux que
//! Claude Code a déposés en s'authentifiant. TRACE ne demande jamais de mot de
//! passe, ne stocke aucun jeton, et n'appelle que cet endpoint de lecture,
//! avec les identifiants de l'utilisateur, pour ses propres données.
//!
//! Le jeton ne quitte jamais ce module : ni journal, ni configuration, ni IPC
//! vers l'interface.

use super::{Cause, Collected, Quota};
use crate::i18n::t;
use crate::util::{home_dir, now_ms};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::Duration;

pub const SOURCE: &str = "anthropic-oauth";
const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// Cadence d'interrogation.
///
/// Ce collecteur est le seul à faire un appel réseau à chaque cycle, et la
/// donnée qu'il rapporte bouge à l'échelle de l'heure — une fenêtre de cinq
/// heures ne change pas en vingt secondes. L'aligner sur le rafraîchissement
/// général, qui ne fait que relire des fichiers locaux, revient à marteler
/// l'API pour rien : c'est ce qui a valu un 429 à la première version, avec
/// une jauge figée à la dernière valeur connue.
///
/// Deux raisons de rester très en dessous de ce qu'on croit permis : une
/// fenêtre de cinq heures ne bouge pas en un quart d'heure, et TRACE partage
/// le jeton — donc le quota de cet endpoint — avec Claude Code lui-même.
pub const MIN_INTERVAL_MS: i64 = 15 * 60 * 1000;

/// Deux régimes de report, parce que deux causes très différentes : un 429
/// signifie que le serveur nous a explicitement écartés, et en conditions
/// réelles il reste fermé bien plus que quelques minutes ; une coupure réseau
/// est passagère, et punir dix minutes une micro-coupure laisse l'utilisateur
/// devant un chiffre figé sans raison valable.
pub const BACKOFF_RATE_LIMIT_MS: i64 = 10 * 60 * 1000;
pub const BACKOFF_TRANSIENT_MS: i64 = 45 * 1000;
const BACKOFF_MAX_MS: i64 = 60 * 60 * 1000;

/// Au-delà, la valeur en cache cesse d'être présentée comme « en direct ».
pub const FRESH_MS: i64 = 45 * 60 * 1000;

const TIMEOUT: Duration = Duration::from_secs(10);

/// État du collecteur, persistable.
///
/// Un relevé de quota est un INSTANTANÉ, pas un événement : l'empiler dans
/// l'index produisait soixante entrées en dix minutes et faisait passer un
/// relevé périmé pour une mesure courante. Il vit donc ici, remplacé à chaque
/// succès.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveState {
    pub fetched_at: i64,
    pub quota: Vec<Quota>,
    pub retry_after: i64,
    pub last_error: Option<String>,
    pub failures: u32,
}

#[derive(Debug, Default)]
struct Cache {
    state: LiveState,
    booted: bool,
    /// Demande explicite de l'utilisateur — le bouton « Actualiser ».
    force_next: bool,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

fn with_cache<T>(f: impl FnOnce(&mut Cache) -> T) -> T {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Cache::default))
}

/// Force un relevé au prochain cycle.
///
/// On lève un drapeau plutôt que de vider le cache : vider `fetched_at` ne
/// survivrait pas à l'amorçage depuis l'état persisté, et le dernier relevé
/// connu serait perdu si l'appel échouait.
///
/// On ne touche ni au report ni au compteur d'échecs : un report en cours
/// vient d'un refus du serveur, et cliquer sur « Actualiser » ne l'annule pas.
pub fn force_refresh() {
    with_cache(|c| c.force_next = true);
}

/// Vide entièrement le cache — réservé aux tests.
pub fn reset_cache() {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

/// Lit le trousseau macOS. Rend `None` plutôt qu'une erreur : l'absence
/// d'identifiants est un cas normal, pas une panne.
fn read_mac_keychain() -> Option<String> {
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Sur Linux et Windows, Claude Code écrit un fichier d'identifiants.
fn read_credentials_file() -> Option<String> {
    let candidates = [
        home_dir().join(".claude").join(".credentials.json"),
        home_dir().join(".config").join("claude").join(".credentials.json"),
    ];
    candidates.iter().find_map(|p| std::fs::read_to_string(p).ok())
}

struct Token {
    value: String,
}

fn load_token() -> Result<Token, String> {
    let raw = if cfg!(target_os = "macos") {
        read_mac_keychain().or_else(read_credentials_file)
    } else {
        read_credentials_file().or_else(read_mac_keychain)
    };
    let Some(raw) = raw else {
        return Err(t("oauth.noCredentials"));
    };

    let Ok(creds) = serde_json::from_str::<Value>(&raw) else {
        return Err(t("oauth.unreadable"));
    };

    // La forme du fichier a changé au fil des versions : on essaie les
    // emplacements connus plutôt que d'en imposer un.
    let o = ["claudeAiOauth", "oauth"]
        .iter()
        .map(|k| &creds[k])
        .find(|v| v.is_object())
        .unwrap_or(&creds);

    let Some(value) = o["accessToken"].as_str().or_else(|| o["access_token"].as_str()) else {
        return Err(t("oauth.noToken"));
    };

    let expires_at = o["expiresAt"].as_i64().or_else(|| o["expires_at"].as_i64());
    if expires_at.is_some_and(|e| e < now_ms()) {
        return Err(t("oauth.expired"));
    }
    Ok(Token { value: value.to_string() })
}

/// Une fenêtre reconnue dans la réponse.
#[derive(Debug, Clone)]
pub struct FoundWindow {
    pub key: String,
    pub percent: f64,
    pub resets_at: Option<i64>,
}

fn percent_of(o: &serde_json::Map<String, Value>) -> Option<f64> {
    for k in ["utilization", "used_percent", "usedPercent", "percent_used", "percentUsed", "percent"] {
        if let Some(v) = o.get(k).and_then(Value::as_f64) {
            // Certaines API rendent une fraction (0..1), d'autres un
            // pourcentage. Les confondre donnerait 0,8 % au lieu de 80 %.
            return Some(if (0.0..=1.0).contains(&v) { v * 100.0 } else { v });
        }
    }
    None
}

fn reset_of(o: &serde_json::Map<String, Value>) -> Option<i64> {
    for k in ["resets_at", "resetsAt", "reset_at", "resetAt", "expires_at"] {
        match o.get(k) {
            Some(Value::Number(n)) => {
                let v = n.as_f64()?;
                // Secondes ou millisecondes : au-delà de 1e11, c'est déjà des ms.
                return Some(if v > 1e11 { v as i64 } else { (v * 1000.0) as i64 });
            }
            Some(Value::String(s)) => {
                if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
                    return Some(d.timestamp_millis());
                }
            }
            _ => {}
        }
    }
    None
}

/// Extrait les fenêtres d'une réponse dont on ne veut pas présumer la forme.
///
/// L'endpoint n'est pas documenté publiquement et sa structure peut changer :
/// plutôt qu'un chemin rigide qui casserait en silence, on parcourt l'arbre et
/// on retient tout objet portant à la fois une notion d'occupation et une
/// notion de réinitialisation. Ce qui n'est pas reconnu est signalé, jamais
/// deviné.
pub fn extract_windows(payload: &Value) -> Vec<FoundWindow> {
    fn walk(node: &Value, label: &str, out: &mut Vec<FoundWindow>, depth: usize) {
        // Une réponse inattendue ne doit pas pouvoir faire tourner la
        // récursion indéfiniment.
        if depth > 12 {
            return;
        }
        match node {
            Value::Array(items) => {
                for (i, v) in items.iter().enumerate() {
                    walk(v, &format!("{label}[{i}]"), out, depth + 1);
                }
            }
            Value::Object(map) => {
                if let Some(pct) = percent_of(map) {
                    let key = ["type", "name", "window"]
                        .iter()
                        .find_map(|k| map.get(*k).and_then(Value::as_str))
                        .unwrap_or(label)
                        .to_string();
                    out.push(FoundWindow {
                        key,
                        percent: pct.clamp(0.0, 100.0),
                        resets_at: reset_of(map),
                    });
                }
                for (k, v) in map {
                    walk(v, k, out, depth + 1);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(payload, "racine", &mut out, 0);
    out
}

/// Fait correspondre une clé de l'API à une fenêtre connue de TRACE.
pub fn normalize_window(key: &str) -> Option<&'static str> {
    let k = key.to_lowercase();
    let has = |pats: &[&str]| pats.iter().any(|p| k.contains(p));
    if has(&["five_hour", "5h", "session", "fivehour"]) {
        return Some("five_hour");
    }
    if has(&["seven_day", "weekly", "week", "7d"]) {
        return Some(if k.contains("opus") { "weekly_opus" } else { "weekly" });
    }
    if k.contains("opus") {
        return Some("weekly_opus");
    }
    None
}

pub fn is_available() -> bool {
    load_token().is_ok()
}

/// Ce que le collecteur rend quand il s'appuie sur son cache.
///
/// Il rend TOUJOURS le dernier relevé connu, quel que soit son âge. Juger de
/// la fraîcheur ici serait une seconde décision au même sujet :
/// `compute_gauges` la prend déjà, et sait afficher un relevé daté en
/// annonçant son âge. Filtrer des deux côtés produisait exactement le
/// contraire du but recherché — le relevé était jeté avant d'arriver à
/// l'affichage, et la jauge retombait sur une estimation fausse.
fn cached(c: &Cache, reason: &str, min_interval: i64) -> Collected {
    let now = now_ms();
    let age = (c.state.fetched_at != 0).then(|| now - c.state.fetched_at);

    // Deux raisons très différentes de ne pas rappeler l'API, et l'interface
    // doit pouvoir les distinguer : la cadence normale n'est pas une panne.
    //
    // La première version ne calculait l'échéance que depuis le report, nul en
    // régime normal — le champ valait donc zéro alors que le prochain relevé
    // était à un quart d'heure. Toute la mécanique écrite pour « dire pourquoi
    // le chiffre ne bouge pas » était aveugle au cas le PLUS courant.
    let backoff_until = c.state.retry_after;
    let paced_until = if c.state.fetched_at != 0 { c.state.fetched_at + min_interval } else { 0 };
    let next_at = backoff_until.max(paced_until);

    let errors = match (&c.state.last_error, c.state.retry_after > now) {
        (Some(e), _) => vec![e.clone()],
        // Un report sans motif connu — hérité d'un redémarrage — doit tout de
        // même se dire : « rien ne bouge » sans explication est le pire cas.
        (None, true) => vec![t("oauth.suspended")],
        _ => vec![],
    };

    Collected {
        events: Vec::new(),
        quota: c.state.quota.clone(),
        ..Collected::default()
    }
    .with_live(LiveStats {
        configured: true,
        from_cache: true,
        age_ms: age,
        stale: age.is_some_and(|a| a > FRESH_MS),
        next_attempt_in: (next_at - now).max(0),
        next_attempt_reason: if backoff_until > now {
            Some("backoff")
        } else if next_at > now {
            Some("cadence")
        } else {
            None
        },
        windows: c.state.quota.len(),
        errors,
        note: Some(reason.to_string()),
        state: c.state.clone(),
    })
}

/// Ce que ce collecteur rapporte de lui-même, au-delà des compteurs communs.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStats {
    pub configured: bool,
    pub from_cache: bool,
    pub age_ms: Option<i64>,
    pub stale: bool,
    pub next_attempt_in: i64,
    pub next_attempt_reason: Option<&'static str>,
    pub windows: usize,
    pub errors: Vec<String>,
    pub note: Option<String>,
    #[serde(skip)]
    pub state: LiveState,
}

impl Collected {
    fn with_live(mut self, live: LiveStats) -> Self {
        self.live = Some(live);
        self
    }
}

fn backoff_for(failures: u32, base: i64) -> i64 {
    let exp = base.saturating_mul(1i64 << (failures.saturating_sub(1).min(20)));
    exp.min(BACKOFF_MAX_MS)
}

pub fn collect(min_interval: i64, persisted: Option<&LiveState>) -> Collected {
    let now = now_ms();

    // Le drapeau de forçage se lit AVANT l'amorçage. La première version
    // remettait `fetched_at` à zéro pour forcer un relevé, et l'amorçage le
    // restaurait aussitôt depuis l'état persisté : le bouton ne faisait plus
    // rien. Deux correctifs ajoutés séparément qui s'annulaient en silence.
    let (forced, should_call) = with_cache(|c| {
        let forced = c.force_next;
        c.force_next = false;

        // Amorçage depuis l'état persisté, TOUJOURS — y compris sur une
        // demande explicite. Il ne fait que restaurer ce qu'on sait déjà.
        // C'est la cadence, et elle seule, que le forçage court-circuite.
        if !c.booted {
            if let Some(p) = persisted {
                c.state = p.clone();
            }
            c.booted = true;
        }

        // Le report après échec s'applique MÊME à une demande explicite :
        // insister sur un 429 ne fait que prolonger la sanction.
        if c.state.retry_after > now {
            return (forced, false);
        }
        if !forced && c.state.fetched_at != 0 && now - c.state.fetched_at < min_interval {
            return (forced, false);
        }
        (forced, true)
    });

    if !should_call {
        let reason = if forced { "report en cours" } else { "relevé récent réutilisé" };
        return with_cache(|c| cached(c, reason, min_interval));
    }

    let token = match load_token() {
        Ok(t) => t,
        Err(e) => {
            return Collected::default().with_live(LiveStats {
                configured: false,
                errors: vec![e],
                ..LiveStats::default()
            })
        }
    };

    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).build();
    let response = agent
        .get(ENDPOINT)
        .set("Authorization", &format!("Bearer {}", token.value))
        .set("anthropic-beta", "oauth-2025-04-20")
        .set("Content-Type", "application/json")
        .call();

    let payload: Value = match response {
        Ok(res) => match res.into_json() {
            Ok(v) => v,
            Err(e) => return fail_transient(&e.to_string(), min_interval),
        },
        Err(ureq::Error::Status(code, res)) => {
            // `Retry-After` fait autorité quand le serveur le donne ; sinon
            // report exponentiel, plafonné.
            let retry_after = res.header("retry-after").and_then(|h| h.parse::<i64>().ok());
            let base = if code == 429 { BACKOFF_RATE_LIMIT_MS } else { BACKOFF_TRANSIENT_MS };
            let hint = match code {
                401 => t("oauth.rejectedToken"),
                429 => t("oauth.tooManyRequests"),
                _ => String::new(),
            };
            return with_cache(|c| {
                c.state.failures += 1;
                let wait = match retry_after {
                    Some(s) if s > 0 => s * 1000,
                    _ => backoff_for(c.state.failures, base),
                };
                c.state.retry_after = now_ms() + wait;
                c.state.last_error = Some(format!("Anthropic {code}{hint}"));
                cached(c, &t("oauth.readFailed"), min_interval)
            });
        }
        Err(e) => {
            let msg = if e.to_string().contains("timed out") { t("oauth.timeout") } else { e.to_string() };
            return fail_transient(&msg, min_interval);
        }
    };

    let windows = extract_windows(&payload);
    let quota: Vec<Quota> = windows
        .iter()
        .filter_map(|w| {
            let kind = normalize_window(&w.key)?;
            Some(Quota {
                source: SOURCE.to_string(),
                ts: now_ms(),
                kind: kind.to_string(),
                status: Some(if w.percent >= 100.0 { "rejected" } else { "ok" }.to_string()),
                resets_at: w.resets_at.unwrap_or(0),
                using_overage: false,
                cause: Cause::Window,
                used_percent: Some(w.percent),
                window_minutes: None,
                plan: None,
            })
        })
        .collect();

    with_cache(|c| {
        // Succès : on repart d'un compteur d'échecs vierge.
        c.state = LiveState {
            fetched_at: now_ms(),
            quota: quota.clone(),
            retry_after: 0,
            last_error: None,
            failures: 0,
        };
        Collected { quota: quota.clone(), ..Collected::default() }.with_live(LiveStats {
            configured: true,
            from_cache: false,
            age_ms: Some(0),
            stale: false,
            // Annoncée dès le succès, et pas seulement au tour suivant : sans
            // cela l'échéance apparaissait une minute après le relevé, comme
            // si elle venait d'un incident.
            next_attempt_in: min_interval,
            next_attempt_reason: Some("cadence"),
            windows: quota.len(),
            // Si la forme de la réponse change, on veut pouvoir le
            // diagnostiquer sans deviner — sans jamais exposer le contenu.
            errors: if windows.is_empty() { vec![t("oauth.unknownShape")] } else { vec![] },
            note: None,
            state: c.state.clone(),
        })
    })
}

fn fail_transient(message: &str, min_interval: i64) -> Collected {
    with_cache(|c| {
        c.state.failures += 1;
        c.state.retry_after = now_ms() + backoff_for(c.state.failures, BACKOFF_TRANSIENT_MS);
        c.state.last_error = Some(message.to_string());
        cached(c, &t("oauth.readFailed"), min_interval)
    })
}
