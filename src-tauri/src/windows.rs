//! Construction et placement des deux fenêtres.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const POPOVER: &str = "popover";
pub const DASHBOARD: &str = "dashboard";

const POPOVER_W: f64 = 380.0;
const POPOVER_H: f64 = 560.0;

/// Le pont `window.trace`, injecté avant tout script de la page.
const BRIDGE: &str = include_str!("bridge.js");

pub fn popover(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(POPOVER)
}

pub fn build_popover(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, POPOVER, WebviewUrl::App("popover/index.html".into()))
        .title("TRACE")
        .inner_size(POPOVER_W, POPOVER_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .initialization_script(BRIDGE)
        .build()
}

pub fn show_dashboard(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(win) = app.get_webview_window(DASHBOARD) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(win);
    }
    let win = WebviewWindowBuilder::new(app, DASHBOARD, WebviewUrl::App("dashboard/index.html".into()))
        .title("TRACE — tableau de bord")
        .inner_size(1080.0, 760.0)
        .min_inner_size(720.0, 520.0)
        .initialization_script(BRIDGE)
        .build()?;
    Ok(win)
}

/// Place le popover sous la barre d'état, aligné à droite.
///
/// L'ancrage exact sur l'icône de la barre n'est pas exposé par Tauri ; le
/// coin haut-droit de l'écran courant est l'approximation qui ne se trompe
/// jamais d'écran, ce qui compte davantage que quelques pixels.
pub fn place_under_menu_bar(win: &WebviewWindow) {
    let Ok(Some(monitor)) = win.current_monitor().or_else(|_| win.primary_monitor()) else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.size().to_logical::<f64>(scale);
    let origin = monitor.position().to_logical::<f64>(scale);

    // Une marge sous la barre, et la même à droite : le popover doit flotter,
    // pas se coller au bord.
    const MARGIN: f64 = 8.0;
    #[cfg(target_os = "macos")]
    const MENU_BAR: f64 = 24.0;
    #[cfg(not(target_os = "macos"))]
    const MENU_BAR: f64 = 0.0;

    let x = origin.x + area.width - POPOVER_W - MARGIN;
    let y = origin.y + MENU_BAR + MARGIN;
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
}
