// La fenêtre de console de Windows n'a rien à faire devant une application de
// barre d'état — mais elle reste utile en développement.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    trace_app_lib::run();
}
