//! Les échecs de démarrage qu'un utilisateur doit pouvoir lire.
//!
//! Une application de barre d'état n'a pas de console : le binaire empaqueté
//! est compilé pour le sous-système « windows », donc un `eprintln!` ou un
//! `panic!` n'y est vu de personne. Le pire échec possible est de ne rien
//! afficher — l'utilisateur double-clique, rien ne se passe, et il n'a aucun
//! moyen de savoir que c'est le moteur web qui manque.

use trace_core::i18n::{self, t, t1};

/// Vérifie que le moteur web du système est présent, avant de construire
/// quoi que ce soit. Sinon : un message lisible, puis on quitte.
///
/// Sous Windows, ce moteur est le runtime WebView2 ; il est livré avec
/// Windows 11 et avec Edge, mais un poste durci, une image allégée ou un
/// Windows 10 ancien peuvent ne pas l'avoir.
pub fn ensure_webview() {
    let Err(error) = tauri::webview_version() else {
        return;
    };
    // Le catalogue n'est pas encore réglé : la configuration n'est chargée
    // qu'au démarrage de l'état, et elle ne doit pas l'être ici.
    i18n::set_locale(i18n::resolve_locale(
        Some("auto"),
        sys_locale::get_locale().as_deref(),
    ));
    let message = t1("startup.webviewMissing", "error", &error);
    eprintln!("{message}");
    fatal(&t("startup.title"), &message);
    std::process::exit(1);
}

/// Affiche une boîte de message bloquante.
#[cfg(windows)]
fn fatal(title: &str, message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let (title, message) = (wide(title), wide(message));
    // SAFETY: les deux tampons sont terminés par un zéro et vivent jusqu'au
    // retour de l'appel, qui bloque jusqu'à la fermeture de la boîte.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

/// Ailleurs, l'échec de chargement du moteur web survient à l'édition de
/// liens, avant `main` : le système le dit lui-même.
#[cfg(not(windows))]
fn fatal(_title: &str, _message: &str) {}
