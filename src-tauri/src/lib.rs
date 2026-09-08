//! La coquille : barre d'état, popover, tableau de bord.
//!
//! Ce lot est délibérément une COQUILLE. Le cœur n'est pas encore porté :
//! `snapshot` sert un instantané produit par la version JS (voir
//! `scripts/dev-fixture.js`), pour éprouver ce qui ne peut l'être autrement —
//! l'empreinte réelle du binaire, et le rendu du SVG écrit à la main par
//! WKWebView plutôt que par Chromium. Si les jauges passent mal, autant le
//! savoir avant de porter deux mille lignes.

mod commands;
mod windows;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Le raccourci global par défaut, `⌘⌥T` (`Ctrl+Alt+T` ailleurs).
fn default_shortcut() -> Shortcut {
    #[cfg(target_os = "macos")]
    let mods = Modifiers::SUPER | Modifiers::ALT;
    #[cfg(not(target_os = "macos"))]
    let mods = Modifiers::CONTROL | Modifiers::ALT;
    Shortcut::new(Some(mods), Code::KeyT)
}

/// Montre ou cache le popover.
///
/// Un popover se comporte comme un popover : s'il est déjà là, le geste qui
/// l'a ouvert le referme. Le rappeler à l'identique donnerait l'impression
/// d'un raccourci mort.
fn toggle_popover(app: &tauri::AppHandle) {
    let Some(win) = windows::popover(app) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        windows::place_under_menu_bar(&win);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let dashboard = MenuItem::with_id(app, "dashboard", "Tableau de bord", true, Some("CmdOrCtrl+Return"))?;
    let quit = MenuItem::with_id(app, "quit", "Quitter TRACE", true, Some("CmdOrCtrl+Q"))?;
    Menu::with_items(app, &[&dashboard, &quit])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Sans ce filtre, le relâchement de touche rouvre aussitôt
                    // ce que l'appui vient de fermer.
                    if event.state() == ShortcutState::Pressed {
                        toggle_popover(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::refresh,
            commands::config_get,
            commands::config_set,
            commands::strings,
            commands::key_set,
            commands::calibrate,
            commands::dashboard_open,
            commands::popover_close,
            commands::export_csv,
            commands::shortcut_status,
            commands::open_external,
            commands::quit,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Aucune icône dans le Dock : TRACE vit dans la barre d'état.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            windows::build_popover(&handle)?;

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id("trace")
                .icon(icon)
                // Sur macOS l'icône est un gabarit : le système la teinte selon
                // le thème de la barre, ce qu'aucune couleur figée ne sait faire.
                .icon_as_template(true)
                .menu(&tray_menu(&handle)?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "dashboard" => {
                        let _ = windows::show_dashboard(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button, button_state, .. } = event {
                        if button == MouseButton::Left && button_state == MouseButtonState::Up {
                            toggle_popover(tray.app_handle());
                        }
                    }
                })
                .build(app)?;

            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            // Un raccourci déjà pris par une autre application n'est pas une
            // raison de refuser de démarrer : l'icône reste cliquable, et
            // `shortcut_status` permettra de le dire dans les réglages.
            if let Err(e) = app.global_shortcut().register(default_shortcut()) {
                eprintln!("raccourci global indisponible : {e}");
            }

            // En développement, les deux fenêtres s'ouvrent d'emblée : une
            // application qui démarre invisible ne se laisse pas éprouver, et
            // c'est le rendu qu'on vient vérifier. `TRACE_DEV_SHOW` fait de
            // même sur un binaire optimisé, seul moyen de mesurer l'empreinte
            // réelle à fenêtres ouvertes plutôt qu'au repos.
            if cfg!(debug_assertions) || std::env::var_os("TRACE_DEV_SHOW").is_some() {
                if let Some(win) = windows::popover(&handle) {
                    windows::place_under_menu_bar(&win);
                    let _ = win.show();
                }
                let _ = windows::show_dashboard(&handle);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Le popover disparaît dès qu'on clique ailleurs. Fermer la
            // fenêtre la détruirait ; on la cache, elle est rouverte telle
            // quelle au geste suivant.
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "popover" && !cfg!(debug_assertions) {
                    let _ = window.hide();
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "popover" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("construction de l'application")
        .run(|_app, event| {
            // Fermer le tableau de bord ne quitte pas : TRACE reste dans la
            // barre d'état, c'est tout son propos.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}

/// Diffuse un nouvel instantané aux fenêtres ouvertes.
#[allow(dead_code)]
pub fn broadcast(app: &tauri::AppHandle, snapshot: &serde_json::Value) {
    use tauri::Emitter;
    let _ = app.emit("trace:update", snapshot);
}
