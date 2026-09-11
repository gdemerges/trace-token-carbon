//! La coquille : barre d'état, popover, tableau de bord.
//!
//! L'instantané servi ici est RÉEL : il vient de `trace_core`, qui lit les
//! journaux de la machine. Ce module ne fait que ce qu'une coquille doit
//! faire — ouvrir des fenêtres, tenir une icône, relayer des appels.

mod commands;
// Public pour que l'exemple de comparaison puisse le vider.
pub mod icon;
mod state;
mod windows;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// L'identifiant de l'icône de barre d'état, pour la retrouver et la
/// redessiner à chaque cycle.
const TRAY_ID: &str = "trace";

/// Côté de l'icône, en pixels physiques.
///
/// On dessine en 2x et on laisse le système réduire : une barre d'état sur
/// écran Retina afficherait sinon une icône floue.
const TRAY_SIZE: u32 = 44;

/// Dessine l'icône au remplissage voulu.
///
/// Hors macOS, l'icône n'est pas un gabarit : la barre d'état n'y affiche
/// aucun texte à côté, et la jauge peinte dans l'icône est la SEULE
/// information disponible d'un coup d'œil. Elle mérite sa couleur.
fn tray_image(fill: Option<f64>) -> tauri::Result<tauri::image::Image<'static>> {
    let template = cfg!(target_os = "macos");
    let png = icon::draw_tray_icon(TRAY_SIZE, fill, template);
    tauri::image::Image::from_bytes(&png).map(|i| i.to_owned())
}

/// Reflète l'état courant dans la barre : le dessin, le titre, l'infobulle.
fn update_tray(app: &tauri::AppHandle, snapshot: &trace_core::core::Snapshot) {
    use trace_core::present;
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let config = app.state::<state::AppState>().config();

    if let Ok(image) = tray_image(present::tray_fill(snapshot)) {
        let _ = tray.set_icon(Some(image));
    }
    // Le titre n'existe que sur macOS ; ailleurs, c'est la jauge peinte dans
    // l'icône qui porte l'information.
    #[cfg(target_os = "macos")]
    let _ = tray.set_title(Some(present::tray_title(snapshot, &config)));
    #[cfg(not(target_os = "macos"))]
    let _ = &config;
    let _ = tray.set_tooltip(Some(present::tray_tooltip(snapshot)));
}

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
    let dashboard = MenuItem::with_id(
        app,
        "dashboard",
        "Tableau de bord",
        true,
        Some("CmdOrCtrl+Return"),
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quitter TRACE", true, Some("CmdOrCtrl+Q"))?;
    Menu::with_items(app, &[&dashboard, &quit])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
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
            commands::renderer_log,
            commands::quit,
        ])
        .manage(state::AppState::boot())
        .setup(|app| {
            let handle = app.handle().clone();

            // Aucune icône dans le Dock : TRACE vit dans la barre d'état.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            windows::build_popover(&handle)?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tray_image(None)?)
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
                    if let TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } = event
                    {
                        if button == MouseButton::Left && button_state == MouseButtonState::Up {
                            toggle_popover(tray.app_handle());
                        }
                    }
                })
                .build(app)?;

            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            // Un raccourci déjà pris par une autre application n'est pas une
            // raison de refuser de démarrer : l'icône reste cliquable, et
            // `shortcut_status` le dit dans les réglages.
            let registered = match app.global_shortcut().register(default_shortcut()) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("raccourci global indisponible : {e}");
                    false
                }
            };
            app.state::<state::AppState>()
                .set_shortcut_registered(registered);

            update_tray(
                &handle,
                &app.state::<state::AppState>()
                    .snapshot(&trace_core::core::SnapshotOptions::default()),
            );
            start_refresh_loop(handle.clone());
            start_update_checks(handle.clone());

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
            match event {
                // Fermer le tableau de bord ne quitte pas : TRACE reste dans
                // la barre d'état, c'est tout son propos.
                tauri::RunEvent::ExitRequested { api, .. } => api.prevent_exit(),
                // On relâche la marque de propriété en partant : le processus
                // suivant n'a pas à attendre cinq minutes qu'elle périme.
                tauri::RunEvent::Exit => trace_core::store::release_ownership(),
                _ => {}
            }
        });
}

/// Rafraîchit en boucle et pousse le résultat aux fenêtres ouvertes.
///
/// Un fil dédié plutôt qu'une tâche asynchrone : le cœur est synchrone, et le
/// travail — relire des fichiers — n'a rien à gagner à un ordonnanceur. Ce qui
/// compte est de ne pas le faire sur le fil de l'interface, où il figerait les
/// fenêtres le temps de la lecture.
fn start_refresh_loop(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let interval = {
            let state = app.state::<state::AppState>();
            let secs = state.config().refresh_interval_sec.clamp(10, 3600);
            std::time::Duration::from_secs(secs)
        };
        std::thread::sleep(interval);

        let state = app.state::<state::AppState>();
        state.refresh();

        let snap = state.snapshot(&trace_core::core::SnapshotOptions::default());

        // Les alertes partent même fenêtres fermées : c'est précisément quand
        // on ne regarde pas l'écran qu'un avertissement a de la valeur.
        notify(&app, state.pending_alerts(&snap));

        // La barre d'état, elle, se met à jour dans tous les cas : c'est la
        // seule chose visible quand aucune fenêtre ne l'est.
        update_tray(&app, &snap);
        // On ne peint que si quelqu'un regarde : recalculer un instantané
        // complet pour l'envoyer à des fenêtres fermées était précisément ce
        // que le dernier commit de la version Electron avait supprimé.
        let watching = app
            .webview_windows()
            .values()
            .any(|w| w.is_visible().unwrap_or(false));
        if watching {
            broadcast(&app, &snap);
        }
    });
}

/// Surveille les versions publiées, sans jamais rien télécharger.
///
/// Une seule annonce par version : réveiller quelqu'un tous les jours pour la
/// même mise à jour est le meilleur moyen de lui faire couper le réglage — et
/// de lui faire manquer la suivante.
fn start_update_checks(app: tauri::AppHandle) {
    use trace_core::update;

    std::thread::spawn(move || {
        // Au démarrage, mais pas DANS le démarrage : la première seconde
        // appartient à l'affichage des chiffres, pas à une requête facultative.
        std::thread::sleep(update::STARTUP_DELAY);
        let mut announced: Option<String> = None;
        loop {
            let enabled = app.state::<state::AppState>().config().check_updates;
            if let Some(found) = update::check(env!("CARGO_PKG_VERSION"), enabled) {
                if announced.as_deref() != Some(found.version.as_str()) {
                    announced = Some(found.version.clone());
                    notify_update(&app, &found);
                }
            }
            std::thread::sleep(update::INTERVAL);
        }
    });
}

/// Annonce une version disponible. L'interface, elle, ouvrira la page si
/// l'utilisateur le demande — rien n'est installé sans son geste.
fn notify_update(app: &tauri::AppHandle, found: &trace_core::update::Update) {
    use tauri::Emitter;
    use tauri_plugin_notification::NotificationExt;
    use trace_core::i18n::t1;

    let title = t1("update.available", "version", &found.version);
    let body = found
        .notes
        .clone()
        .unwrap_or_else(|| t1("update.body", "version", &found.version));
    if let Err(e) = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
    {
        eprintln!("notification de mise à jour refusée : {e}");
    }
    // L'interface reçoit aussi l'annonce : une notification système se rate,
    // un bandeau dans la fenêtre attend qu'on la regarde.
    let _ = app.emit("trace:update-available", found);
}

/// Émet les notifications système décidées par le cœur.
fn notify(app: &tauri::AppHandle, notifications: Vec<trace_core::alerts::Notification>) {
    use tauri_plugin_notification::NotificationExt;
    for n in notifications {
        if let Err(e) = app
            .notification()
            .builder()
            .title(&n.title)
            .body(&n.body)
            .show()
        {
            eprintln!("notification refusée : {e}");
        }
    }
}

/// Diffuse un nouvel instantané aux fenêtres ouvertes.
fn broadcast<T: serde::Serialize + Clone>(app: &tauri::AppHandle, snapshot: &T) {
    use tauri::Emitter;
    let _ = app.emit("trace:update", snapshot);
}
