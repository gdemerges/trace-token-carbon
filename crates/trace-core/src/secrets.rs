//! Les clés Admin, dans le trousseau du système — jamais sur le disque en clair.
//!
//! Keychain sous macOS, Gestionnaire d'identifiants sous Windows, Secret
//! Service (GNOME Keyring, KWallet) sous Linux. La configuration ne porte plus
//! aucune clé : `config.json` peut être sauvegardé, synchronisé ou lu par un
//! autre compte sans rien livrer.
//!
//! Un trousseau indisponible est une ERREUR, pas un motif de repli : écrire la
//! clé en clair « en attendant » reviendrait exactement à ce que ce module
//! existe pour empêcher.

use std::collections::HashMap;
use std::sync::Mutex;

/// Le nom sous lequel les entrées apparaissent dans le trousseau.
const SERVICE: &str = "TRACE";

/// Les fournisseurs dont TRACE garde une clé, et le nom de chaque entrée.
pub const PROVIDERS: [&str; 2] = ["anthropic", "openai"];

fn account(provider: &str) -> Result<&'static str, String> {
    match provider {
        "anthropic" => Ok("anthropic-admin-key"),
        "openai" => Ok("openai-admin-key"),
        other => Err(format!("fournisseur inconnu : {other}")),
    }
}

/// Stockage de substitution, en mémoire, pour les tests.
///
/// Les tests ne doivent JAMAIS toucher au trousseau réel de la machine qui les
/// lance : ils y laisseraient des entrées, ou écraseraient celles de
/// l'utilisateur.
static MEMORY: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Bascule le processus sur un trousseau en mémoire, vide. Réservé aux tests.
pub fn use_memory_backend() {
    if let Ok(mut m) = MEMORY.lock() {
        *m = Some(HashMap::new());
    }
}

fn with_memory<R>(f: impl FnOnce(&mut HashMap<String, String>) -> R) -> Option<R> {
    let mut guard = MEMORY.lock().ok()?;
    guard.as_mut().map(f)
}

/// Lit la clé d'un fournisseur. `None` quand il n'y en a pas, ou que le
/// trousseau ne répond pas — dans les deux cas, la source concernée ne peut
/// pas interroger l'API, et elle le dira.
pub fn get(provider: &str) -> Option<String> {
    let account = account(provider).ok()?;
    if let Some(v) = with_memory(|m| m.get(account).cloned()) {
        return v;
    }
    match keyring::Entry::new(SERVICE, account).and_then(|e| e.get_password()) {
        Ok(v) if !v.is_empty() => Some(v),
        Ok(_) | Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            log::warn!("trousseau : lecture de {account} impossible : {e}");
            None
        }
    }
}

/// Enregistre la clé d'un fournisseur ; `None` ou une chaîne vide l'efface.
pub fn set(provider: &str, value: Option<&str>) -> Result<(), String> {
    let account = account(provider)?;
    let value = value.map(str::trim).filter(|v| !v.is_empty());
    let in_memory = with_memory(|m| match value {
        Some(v) => {
            m.insert(account.to_string(), v.to_string());
        }
        None => {
            m.remove(account);
        }
    });
    if in_memory.is_some() {
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
    match value {
        Some(v) => entry.set_password(v).map_err(|e| e.to_string()),
        // Effacer ce qui n'existe pas n'est pas une erreur.
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

/// Le trousseau répond-il ? L'interface l'annonce AVANT que l'utilisateur ne
/// colle une clé, plutôt que de refuser après coup.
pub fn available() -> bool {
    if with_memory(|_| ()).is_some() {
        return true;
    }
    let Ok(account) = account(PROVIDERS[0]) else {
        return false;
    };
    match keyring::Entry::new(SERVICE, account).and_then(|e| e.get_password()) {
        Ok(_) | Err(keyring::Error::NoEntry) => true,
        Err(_) => false,
    }
}
