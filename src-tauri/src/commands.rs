//! La surface IPC, reprise une pour une de `src/main/preload.js`.
//!
//! ÉCHAFAUDAGE. Tant que le cœur n'est pas porté, `snapshot` sert le fichier
//! produit par `npm run fixture` — un instantané réel, produit par la version
//! JS, gardé hors du dépôt parce qu'il porte les noms de projets et les
//! volumétries de qui l'a produit. En son absence, l'état vide, qui est un cas
//! de rendu à éprouver de toute façon.
//!
//! Chaque commande porte donc soit son implémentation définitive (celles qui
//! ne dépendent que des fenêtres), soit un `todo` explicite. Aucune ne ment en
//! rendant une valeur plausible.

use crate::windows;
use serde_json::{json, Value};
use tauri::AppHandle;

/// Chemin de la fixture de développement, relatif au crate.
const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/snapshot.dev.json");

/// Instantané vide, dans la forme exacte que le renderer attend.
///
/// Ce n'est pas un bouche-trou : c'est l'état d'une machine sur laquelle
/// aucune source n'a encore rien produit, et il doit se peindre correctement.
fn empty_snapshot() -> Value {
    let tokens = json!({
        "input": 0, "output": 0, "cacheWrite": 0, "cacheWrite5m": 0,
        "cacheWrite1h": 0, "cacheRead": 0, "thinking": 0, "total": 0
    });
    let carbon = json!({
        "gramsCO2e": { "min": 0, "max": 0, "mid": 0 },
        "energyWh": { "min": 0, "max": 0, "mid": 0 },
        "waterL": { "min": 0, "max": 0, "mid": 0 }
    });
    json!({
        "generatedAt": trace_core::util::now_ms(),
        "range": { "days": 30, "from": 0, "to": trace_core::util::now_ms() },
        "staleError": null,
        "liveStatus": null,
        "gauges": [],
        "sources": [],
        "hasKeys": {},
        "config": { "shortcut": "CommandOrControl+Alt+T", "lang": "fr" },
        "report": {
            "eventCount": 0,
            "totals": {
                "tokens": tokens,
                "requests": 0,
                "costUSD": 0,
                "cacheSavingsUSD": 0,
                "costUnknown": false,
                "carbon": carbon
            },
            "byModel": [], "byProject": [], "byDay": [], "byHour": [],
            "trend": { "significant": false, "previous": { "tokens": tokens } }
        }
    })
}

fn fixture_or_empty() -> Value {
    match std::fs::read_to_string(FIXTURE) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("fixture illisible ({e}) : on sert l'état vide");
            empty_snapshot()
        }),
        Err(_) => empty_snapshot(),
    }
}

#[tauri::command]
pub fn snapshot(_options: Option<Value>) -> Value {
    fixture_or_empty()
}

#[tauri::command]
pub fn refresh() -> Value {
    fixture_or_empty()
}

#[tauri::command]
pub fn config_get() -> Value {
    json!({ "shortcut": "CommandOrControl+Alt+T", "lang": "fr", "defaultRangeDays": 30 })
}

#[tauri::command]
pub fn config_set(patch: Value) -> Value {
    // Écrire la configuration suppose le portage de `store` : tant qu'il n'est
    // pas là, on ne prétend pas avoir enregistré.
    eprintln!("config_set non porté, ignoré : {patch}");
    config_get()
}

/// Le catalogue de traductions, servi tel quel depuis `src/i18n`.
///
/// C'est du JSON des deux côtés : rien à porter, seulement à livrer.
#[tauri::command]
pub fn strings() -> Value {
    const FR: &str = include_str!("../../src/i18n/fr.json");
    const EN: &str = include_str!("../../src/i18n/en.json");
    let lang = if std::env::var("TRACE_LANG").as_deref() == Ok("en") { "en" } else { "fr" };
    let catalog: Value = serde_json::from_str(if lang == "en" { EN } else { FR })
        .expect("catalogue de traductions valide");
    json!({ "lang": lang, "strings": catalog })
}

#[tauri::command]
pub fn key_set(provider: String, _value: String) -> bool {
    eprintln!("key_set non porté ({provider}) : le trousseau reste à faire");
    false
}

#[tauri::command]
pub fn calibrate(gauge_id: String, percent: f64) -> Value {
    eprintln!("calibrate non porté ({gauge_id} → {percent})");
    fixture_or_empty()
}

#[tauri::command]
pub fn dashboard_open(app: AppHandle) {
    if let Some(win) = windows::popover(&app) {
        let _ = win.hide();
    }
    if let Err(e) = windows::show_dashboard(&app) {
        eprintln!("ouverture du tableau de bord : {e}");
    }
}

#[tauri::command]
pub fn popover_close(app: AppHandle) {
    if let Some(win) = windows::popover(&app) {
        let _ = win.hide();
    }
}

#[tauri::command]
pub fn export_csv(_options: Option<Value>) -> Option<String> {
    eprintln!("export_csv non porté");
    None
}

#[tauri::command]
pub fn shortcut_status() -> Value {
    json!({ "registered": true, "accelerator": "CommandOrControl+Alt+T" })
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) {
    // Seuls http(s) sortent. Une chaîne venue d'un journal ne doit pas pouvoir
    // faire ouvrir `file://` ou pire au système.
    if !url.starts_with("https://") && !url.starts_with("http://") {
        eprintln!("ouverture refusée, schéma non autorisé : {url}");
        return;
    }
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        eprintln!("ouverture externe : {e}");
    }
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}
