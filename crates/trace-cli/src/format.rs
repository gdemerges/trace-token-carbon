//! Mise en forme des nombres, dans la langue courante.
//!
//! Le français sépare les milliers par une espace insécable et emploie la
//! virgule décimale ; l'anglais fait l'inverse. Formater « à la main » plutôt
//! qu'avec une bibliothèque d'internationalisation complète est assumé : deux
//! langues, deux règles, et aucune dépendance de plus dans un binaire qu'on
//! veut petit.

use trace_core::i18n::current_locale;

/// Espace insécable étroite, celle qu'emploie la typographie française pour
/// les milliers.
const NBSP: char = '\u{202f}';

pub fn num(value: f64, decimals: usize) -> String {
    let french = current_locale() == "fr";
    let s = format!("{:.*}", decimals, value.abs());
    let (int_part, frac) = match s.split_once('.') {
        Some((i, f)) => (i.to_string(), Some(f.to_string())),
        None => (s, None),
    };

    let mut grouped = String::new();
    for (i, c) in int_part.chars().enumerate() {
        if i > 0 && (int_part.len() - i) % 3 == 0 {
            grouped.push(if french { NBSP } else { ',' });
        }
        grouped.push(c);
    }

    let mut out = String::new();
    if value < 0.0 {
        out.push('-');
    }
    out.push_str(&grouped);
    if let Some(f) = frac {
        out.push(if french { ',' } else { '.' });
        out.push_str(&f);
    }
    out
}

/// Volume de tokens, abrégé — la seule échelle lisible quand on compte en
/// milliards.
pub fn tokens(n: f64) -> String {
    if n >= 1e9 {
        format!("{} Md", num(n / 1e9, 2))
    } else if n >= 1e6 {
        format!("{} M", num(n / 1e6, 1))
    } else if n >= 1e3 {
        format!("{} k", num(n / 1e3, 1))
    } else {
        num(n, 0)
    }
}

pub fn co2(g: f64) -> String {
    if g >= 1e6 {
        format!("{} t", num(g / 1e6, 2))
    } else if g >= 1000.0 {
        format!("{} kg", num(g / 1000.0, 1))
    } else {
        format!("{} g", num(g, 1))
    }
}

/// Un coût inconnu s'écrit « — », jamais « $0 » : la gratuité et l'ignorance
/// ne sont pas la même information.
pub fn usd(n: Option<f64>) -> String {
    match n {
        None => "—".to_string(),
        Some(v) if v >= 1000.0 => format!("${}", num(v, 0)),
        Some(v) => format!("${}", num(v, 2)),
    }
}

pub fn water(l: f64) -> String {
    if l >= 1000.0 {
        format!("{} m³", num(l / 1000.0, 1))
    } else if l >= 1.0 {
        format!("{} L", num(l, 1))
    } else {
        format!("{} mL", num(l * 1000.0, 0))
    }
}

/// Aligne à gauche sur une largeur donnée, en comptant les CARACTÈRES et non
/// les octets : « é » en fait deux, et un `format!("{:<20}")` naïf décalerait
/// toute la colonne sur les libellés accentués.
pub fn pad(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(width - len))
    }
}

pub fn pad_start(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        s.to_string()
    } else {
        format!("{}{s}", " ".repeat(width - len))
    }
}
