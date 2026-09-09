//! Écrit les icônes de barre d'état pour la comparaison différentielle avec la
//! version JS. Non distribué.

fn main() {
    let dir = std::env::args().nth(1).expect("répertoire de sortie");
    std::fs::create_dir_all(&dir).unwrap();
    for size in [22u32, 44] {
        for fill in [None, Some(0.0), Some(0.37), Some(1.0)] {
            for template in [true, false] {
                let png = trace_app_lib::icon::draw_tray_icon(size, fill, template);
                let tag = match fill {
                    None => "none".to_string(),
                    Some(f) => format!("{f}"),
                };
                let name = format!("{size}-{tag}-{}.png", if template { "tpl" } else { "col" });
                std::fs::write(std::path::Path::new(&dir).join(name), png).unwrap();
            }
        }
    }
}
