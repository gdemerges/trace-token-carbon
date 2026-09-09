//! Générateur d'icônes de barre d'état, en PNG, sans aucune dépendance
//! graphique ni fichier binaire versionné.
//!
//! Pourquoi ne pas simplement livrer un `.png` ? Parce que l'icône doit
//! refléter l'état. Sur Windows et Linux, la barre d'état n'affiche pas de
//! texte à côté de l'icône — contrairement à macOS et son titre. Le seul moyen
//! d'y donner une information d'un coup d'œil est donc de la DESSINER dans
//! l'icône : une petite jauge dont le remplissage suit la consommation.

use std::io::Write;

/// Table de CRC-32, celle du format PNG.
fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: std::sync::LazyLock<[u32; 256]> = std::sync::LazyLock::new(|| {
        let mut t = [0u32; 256];
        for (n, slot) in t.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        t
    });
    let mut c = 0xffff_ffffu32;
    for b in bytes {
        c = TABLE[((c ^ *b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 12);
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = Vec::with_capacity(data.len() + 4);
    body.extend_from_slice(kind);
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out
}

/// Encode un tampon RGBA en PNG.
fn encode_png(rgba: &[u8], size: u32) -> Vec<u8> {
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&size.to_be_bytes());
    ihdr.extend_from_slice(&size.to_be_bytes());
    ihdr.push(8); // 8 bits par canal
    ihdr.push(6); // RGBA
    ihdr.extend_from_slice(&[0, 0, 0]); // compression, filtre, entrelacement

    // Chaque ligne est préfixée de son octet de filtre (0 = aucun).
    let w = size as usize;
    let mut raw = Vec::with_capacity((w * 4 + 1) * w);
    for y in 0..w {
        raw.push(0);
        raw.extend_from_slice(&rgba[y * w * 4..(y + 1) * w * 4]);
    }

    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    let _ = encoder.write_all(&raw);
    let idat = encoder.finish().unwrap_or_default();

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend(chunk(b"IHDR", &ihdr));
    png.extend(chunk(b"IDAT", &idat));
    png.extend(chunk(b"IEND", &[]));
    png
}

/// La grille de référence sur laquelle le symbole est dessiné.
const GRID: f64 = 22.0;

/// Dessine le symbole TRACE : un trait d'enregistreur graphique, surmonté
/// d'une jauge de remplissage.
///
/// `fill` va de 0 à 1 ; `None` n'affiche aucune jauge. En mode gabarit,
/// l'icône est noire et ne porte que son alpha : c'est le système qui la
/// teinte selon le thème de la barre, ce qu'aucune couleur figée ne sait
/// faire.
pub fn draw_tray_icon(size: u32, fill: Option<f64>, template: bool) -> Vec<u8> {
    let n = size as usize;
    let mut rgba = vec![0u8; n * n * 4];
    let s = size as f64 / GRID;
    let (r, g, b) = if template { (0, 0, 0) } else { (255, 180, 84) };

    let mut px = |x: f64, y: f64, a: f64| {
        let (xi, yi) = (x.round(), y.round());
        if xi < 0.0 || yi < 0.0 || xi >= size as f64 || yi >= size as f64 {
            return;
        }
        let i = (yi as usize * n + xi as usize) * 4;
        // On garde l'alpha le plus opaque : les segments du tracé se
        // recouvrent, et les composer les épaissirait aux jointures.
        let alpha = rgba[i + 3].max((a.clamp(0.0, 1.0) * 255.0).round() as u8);
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = alpha;
    };

    // --- Le tracé : une courbe échantillonnée, comme un stylet sur le papier.
    const POINTS: [f64; 10] = [0.08, 0.5, 0.26, 0.82, 0.44, 0.14, 0.63, 0.66, 0.92, 0.34];
    let trace_top = 3.5 * s;
    let trace_h = 11.0 * s;
    let thickness = (2.4 * s).round().max(2.0) as i32;

    for i in (0..POINTS.len() - 2).step_by(2) {
        let x1 = POINTS[i] * size as f64;
        let y1 = trace_top + (1.0 - POINTS[i + 1]) * trace_h;
        let x2 = POINTS[i + 2] * size as f64;
        let y2 = trace_top + (1.0 - POINTS[i + 3]) * trace_h;
        let steps = ((x2 - x1).hypot(y2 - y1) * 3.0).ceil().max(2.0) as i32;
        for k in 0..=steps {
            let t = k as f64 / steps as f64;
            let x = x1 + (x2 - x1) * t;
            let y = y1 + (y2 - y1) * t;
            // Épaissi verticalement ET horizontalement : sur une pente raide,
            // un épaississement seulement vertical laisse la ligne maigre.
            for d in 0..thickness {
                px(x, y + d as f64, 1.0);
                px(x + 0.5, y + d as f64, 1.0);
            }
        }
    }

    // --- La jauge d'état, en pied d'icône.
    if let Some(fill) = fill {
        let bar_y = (17.5 * s).round();
        let bar_h = (1.8 * s).round().max(1.0) as i32;
        let bar_x = (1.5 * s).round();
        let bar_w = (19.0 * s).round() as i32;
        let mut rect = |x0: f64, y0: f64, w: i32, h: i32, a: f64| {
            for y in 0..h {
                for x in 0..w {
                    px(x0 + x as f64, y0 + y as f64, a);
                }
            }
        };
        rect(bar_x, bar_y, bar_w, bar_h, 0.22); // le rail
        let filled = (bar_w as f64 * fill.clamp(0.0, 1.0)).round() as i32;
        if filled > 0 {
            rect(bar_x, bar_y, filled, bar_h, 1.0);
        }
    }

    encode_png(&rgba, size)
}
