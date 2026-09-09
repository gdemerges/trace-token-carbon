//! L'état partagé de l'application : la configuration, l'index et le dernier
//! relevé, derrière un verrou.
//!
//! Le cœur est synchrone et rapide — 0,23 s sur 186 Mo de journaux — donc un
//! `Mutex` suffit largement, et évite toute la complexité d'un état
//! asynchrone pour une opération qui a lieu une fois par minute.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use trace_core::core::{self, Snapshot, SnapshotOptions, State as CoreState};
use trace_core::store::{self, Config};

pub struct AppState {
    inner: Mutex<CoreState>,
    shortcut_registered: AtomicBool,
}

impl AppState {
    /// Premier chargement : on se déclare propriétaire de l'index, puis on lit.
    pub fn boot() -> Self {
        let config = store::load_config();
        trace_core::i18n::set_locale(&config.locale);
        store::claim_ownership(trace_core::util::now_ms());
        AppState {
            inner: Mutex::new(core::refresh(config, true)),
            shortcut_registered: AtomicBool::new(false),
        }
    }

    pub fn refresh(&self) {
        let config = {
            let Ok(s) = self.inner.lock() else { return };
            s.config.clone()
        };
        // On rafraîchit la marque de propriété à chaque cycle : c'est elle qui
        // dit aux autres processus que nous sommes toujours là.
        store::claim_ownership(trace_core::util::now_ms());
        let next = core::refresh(config, true);
        if let Ok(mut s) = self.inner.lock() {
            *s = next;
        }
    }

    pub fn snapshot(&self, opts: &SnapshotOptions) -> Snapshot {
        let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        core::snapshot(&s, opts)
    }

    pub fn config(&self) -> Config {
        let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        s.config.clone()
    }

    /// Applique une modification partielle venue de l'interface.
    ///
    /// On fusionne dans le JSON de la configuration courante plutôt que de
    /// désérialiser le correctif seul : un correctif ne porte que les champs
    /// qui changent, et le désérialiser directement remettrait tous les autres
    /// à leur défaut.
    pub fn patch_config(&self, patch: serde_json::Value) -> Result<Config, String> {
        let current = self.config();
        let mut merged = serde_json::to_value(&current).map_err(|e| e.to_string())?;
        merge(&mut merged, &patch);
        let next: Config = serde_json::from_value(merged).map_err(|e| e.to_string())?;
        store::save_config(&next).map_err(|e| e.to_string())?;
        trace_core::i18n::set_locale(&next.locale);
        if let Ok(mut s) = self.inner.lock() {
            s.config = next.clone();
        }
        Ok(next)
    }

    pub fn calibrate(&self, gauge_id: &str, percent: f64) -> Result<(), String> {
        let next = {
            let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            core::calibrate(&s, gauge_id, percent)?
        };
        if let Ok(mut s) = self.inner.lock() {
            s.config = next;
        }
        Ok(())
    }

    pub fn set_shortcut_registered(&self, ok: bool) {
        self.shortcut_registered.store(ok, Ordering::Relaxed);
    }

    pub fn shortcut_registered(&self) -> bool {
        self.shortcut_registered.load(Ordering::Relaxed)
    }
}

/// Fusion récursive : un objet se fusionne champ à champ, tout le reste
/// remplace. C'est ce que fait l'étalement d'objets côté JS.
fn merge(target: &mut serde_json::Value, patch: &serde_json::Value) {
    match (target, patch) {
        (serde_json::Value::Object(t), serde_json::Value::Object(p)) => {
            for (k, v) in p {
                merge(t.entry(k.clone()).or_insert(serde_json::Value::Null), v);
            }
        }
        (t, p) => *t = p.clone(),
    }
}
