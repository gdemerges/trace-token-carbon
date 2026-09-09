//! La surface IPC, reprise une pour une de `src/main/preload.js`.
//!
//! L'instantané est désormais RÉEL : il vient de `trace_core`, qui lit les
//! journaux de la machine, résout les modèles, chiffre le coût et l'empreinte
//! et reconstruit les fenêtres de limitation. La fixture de développement a
//! disparu avec elle.
//!
//! Ce qui reste non porté le dit au journal plutôt que de rendre une valeur
//! plausible : les trois collecteurs réseau, et l'annexe méthodologique.

use crate::state::AppState;
use crate::windows;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use trace_core::core::SnapshotOptions;
use trace_core::i18n;

/// Traduit les options venues de l'interface.
///
/// Le renderer envoie `days: 'all'` pour « aussi loin que possible » : une
/// chaîne là où les autres valeurs sont des nombres. On la reconnaît ici
/// plutôt que de laisser la désérialisation échouer en silence et retomber sur
/// trente jours sans rien dire.
fn snapshot_options(options: Option<Value>) -> SnapshotOptions {
    let Some(o) = options else {
        return SnapshotOptions::default();
    };
    let days = &o["days"];
    if days.as_str() == Some("all") {
        return SnapshotOptions { all: true, ..SnapshotOptions::default() };
    }
    SnapshotOptions { days: days.as_i64(), all: false, to: o["to"].as_i64() }
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn snapshot(state: State<'_, AppState>, options: Option<Value>) -> Value {
    to_value(&state.snapshot(&snapshot_options(options)))
}

#[tauri::command]
pub fn refresh(state: State<'_, AppState>) -> Value {
    state.refresh();
    to_value(&state.snapshot(&SnapshotOptions::default()))
}

#[tauri::command]
pub fn config_get(state: State<'_, AppState>) -> Value {
    // Jamais de clé vers l'interface : elle n'a besoin que de savoir qu'il y
    // en a une, ce que porte `hasKeys` dans l'instantané.
    let mut c = state.config();
    c.anthropic_admin_key = None;
    c.openai_admin_key = None;
    to_value(&c)
}

#[tauri::command]
pub fn config_set(state: State<'_, AppState>, patch: Value) -> Value {
    match state.patch_config(patch) {
        Ok(c) => to_value(&c),
        Err(e) => {
            eprintln!("config_set : {e}");
            config_get(state)
        }
    }
}

/// Le catalogue de traductions, servi tel quel. C'est du JSON des deux côtés :
/// rien à porter, seulement à livrer.
#[tauri::command]
pub fn strings(state: State<'_, AppState>) -> Value {
    let locale = i18n::resolve_locale(Some(&state.config().locale), sys_locale().as_deref());
    i18n::set_locale(locale);
    json!({ "lang": locale, "strings": i18n::catalog_json(locale) })
}

/// Langue du système.
///
/// Surtout pas `LANG` : le terminal la fixe, et elle vaut couramment
/// « en_US.UTF-8 » sur un poste réglé en français — l'application lancée
/// depuis un terminal s'affichait alors en anglais. On demande au système.
fn sys_locale() -> Option<String> {
    sys_locale::get_locale()
}

#[tauri::command]
pub fn key_set(provider: String, _value: String) -> bool {
    eprintln!("key_set non porté ({provider}) : les collecteurs réseau restent à faire");
    false
}

#[tauri::command]
pub fn calibrate(state: State<'_, AppState>, gauge_id: String, percent: f64) -> Value {
    match state.calibrate(&gauge_id, percent) {
        Ok(()) => to_value(&state.snapshot(&SnapshotOptions::default())),
        Err(e) => json!({ "error": e }),
    }
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
pub fn shortcut_status(state: State<'_, AppState>) -> Value {
    json!({
        "registered": state.shortcut_registered(),
        "accelerator": state.config().shortcut,
    })
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) {
    // Seuls http(s) sortent. Une chaîne venue d'un journal — nom de projet ou
    // de modèle — ne doit pas pouvoir faire ouvrir `file://` ou pire.
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
    trace_core::store::release_ownership();
    app.exit(0);
}
