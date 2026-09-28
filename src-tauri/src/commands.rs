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
        return SnapshotOptions {
            all: true,
            ..SnapshotOptions::default()
        };
    }
    SnapshotOptions {
        days: days.as_i64(),
        all: false,
        to: o["to"].as_i64(),
    }
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
    // Jamais de clé vers l'interface — elles ne sont d'ailleurs pas
    // sérialisées. Elle n'a besoin que de savoir qu'il y en a une, et si le
    // trousseau répond.
    let c = state.config();
    let mut v = to_value(&c);
    if let Some(o) = v.as_object_mut() {
        o.insert(
            "hasKeys".into(),
            json!({
                "anthropic": c.anthropic_admin_key.is_some(),
                "openai": c.openai_admin_key.is_some(),
            }),
        );
        o.insert(
            "encryptionAvailable".into(),
            json!(trace_core::secrets::available()),
        );
    }
    v
}

#[tauri::command]
pub fn config_set(app: AppHandle, state: State<'_, AppState>, mut patch: Value) -> Value {
    // Le raccourci d'abord : s'il est refusé, on ne l'enregistre pas — le
    // reste du correctif, lui, s'applique. Enregistrer une chaîne qu'on sait
    // inopérante ferait mentir les réglages au prochain démarrage.
    let old_shortcut = state.config().shortcut;
    let mut shortcut_ok = true;
    let requested = patch["shortcut"].as_str().map(|s| s.trim().to_string());
    if let Some(new) = requested.filter(|n| *n != old_shortcut) {
        shortcut_ok = crate::replace_shortcut(&app, &old_shortcut, &new);
        state.set_shortcut_registered(shortcut_ok || state.shortcut_registered());
        if !shortcut_ok {
            if let Some(p) = patch.as_object_mut() {
                p.remove("shortcut");
            }
        }
    }

    match state.patch_config(patch) {
        Ok(c) => {
            crate::apply_launch_at_login(&app, c.launch_at_login);
            let mut v = to_value(&c);
            // Absent quand rien n'a changé : l'interface ne teste que `false`.
            if !shortcut_ok {
                if let Some(o) = v.as_object_mut() {
                    o.insert("shortcutOk".into(), json!(false));
                }
            }
            v
        }
        Err(e) => {
            log::error!("config_set : {e}");
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
    // `locale` et `intlLocale` sont les noms que lit `initI18n` : n'envoyer
    // que `lang` laissait l'interface anglaise formater nombres et dates à la
    // française (« 1 234,5 »).
    let intl_locale = match locale {
        "en" => "en-US",
        _ => "fr-FR",
    };
    json!({
        "locale": locale,
        "intlLocale": intl_locale,
        "strings": i18n::catalog_json(locale),
    })
}

/// Langue du système.
///
/// Surtout pas `LANG` : le terminal la fixe, et elle vaut couramment
/// « en_US.UTF-8 » sur un poste réglé en français — l'application lancée
/// depuis un terminal s'affichait alors en anglais. On demande au système.
fn sys_locale() -> Option<String> {
    sys_locale::get_locale()
}

/// Enregistre une clé Admin dans le trousseau du système.
///
/// `null` ou une chaîne vide EFFACE la clé plutôt que d'en stocker une vide :
/// c'est le geste par lequel l'utilisateur retire son accès, et une chaîne
/// vide passée à l'API produirait un 401 incompréhensible.
///
/// Rend `{ ok, error }`, la forme qu'attend l'écran de réglages : un simple
/// booléen n'y affichait qu'un « undefined » en cas d'échec.
#[tauri::command]
pub fn key_set(state: State<'_, AppState>, provider: String, value: Option<String>) -> Value {
    match state.set_key(&provider, value.as_deref()) {
        Ok(()) => {
            // La clé change ce que les sources peuvent lire : on relit tout de
            // suite plutôt que d'attendre le prochain cycle.
            state.refresh();
            json!({ "ok": true })
        }
        Err(e) => {
            log::error!("key_set : {e}");
            json!({ "ok": false, "error": i18n::t1("set.keychainError", "error", e) })
        }
    }
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
        log::error!("ouverture du tableau de bord : {e}");
    }
}

#[tauri::command]
pub fn popover_close(app: AppHandle) {
    if let Some(win) = windows::popover(&app) {
        let _ = win.hide();
    }
}

/// Écrit un export dans le dossier Téléchargements et rend son chemin.
///
/// Sans boîte de dialogue : un export doit atterrir quelque part de prévisible
/// et se dire dans un message. L'heure est dans le nom, pour qu'un second
/// export du jour n'écrase pas le premier.
fn save_export(
    stem: &str,
    suffix: &str,
    ext: &str,
    content: &str,
) -> Result<std::path::PathBuf, String> {
    let dir =
        dirs::download_dir().unwrap_or_else(|| trace_core::util::home_dir().join("Downloads"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S");
    let path = dir.join(format!("{stem}-{stamp}{suffix}.{ext}"));
    std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

fn export_result(res: Result<Value, String>) -> Value {
    res.unwrap_or_else(|e| {
        log::error!("export : {e}");
        json!({ "ok": false, "error": e })
    })
}

/// Exporte les données en CSV, plus l'annexe méthodologique à côté.
///
/// Un tableau de grammes sans les facteurs qui l'ont produit n'est pas
/// vérifiable : les deux fichiers partent ensemble. Rend la forme qu'attend
/// l'interface — `{ ok, rows, filePath }` — et non le texte brut : rendre le
/// CSV sans l'écrire laissait le bouton d'export muet.
#[tauri::command]
pub fn export_csv(state: State<'_, AppState>, options: Option<Value>) -> Value {
    export_result((|| {
        let (data, method) = state.export_csv(&snapshot_options(options));
        let path = save_export("trace-export", "", "csv", &data)?;
        save_export("trace-export", "-methodology", "csv", &method)?;
        Ok(json!({
            "ok": true,
            // Sans l'en-tête.
            "rows": data.lines().count().saturating_sub(1),
            "filePath": path.to_string_lossy(),
        }))
    })())
}

/// Exporte le rapport carbone en Markdown.
#[tauri::command]
pub fn export_report(state: State<'_, AppState>, options: Option<Value>) -> Value {
    export_result((|| {
        let md = state.report_markdown(&snapshot_options(options));
        let path = save_export("trace-carbon-report", "", "md", &md)?;
        Ok(json!({ "ok": true, "filePath": path.to_string_lossy() }))
    })())
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
    // HTTPS vers une liste fermée d'hôtes : le dépôt et les éditeurs des
    // sources citées. Voir `trace_core::util::external_url_allowed`.
    if !trace_core::util::external_url_allowed(&url) {
        log::warn!("ouverture refusée, adresse hors liste : {url}");
        return;
    }
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        log::error!("ouverture externe : {e}");
    }
}

/// Remonte une erreur du renderer au journal du processus principal.
///
/// Sans cela, une exception dans une vue reste invisible : elle vide un écran
/// et personne ne sait pourquoi.
#[tauri::command]
pub fn renderer_log(kind: String, message: String, source: String, line: u32) {
    let origin = if source.is_empty() {
        String::new()
    } else {
        format!(" [{source}:{line}]")
    };
    log::error!("renderer/{kind}{origin} : {message}");
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    trace_core::store::release_ownership();
    app.exit(0);
}
