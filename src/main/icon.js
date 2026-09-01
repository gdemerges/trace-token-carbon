'use strict';

const zlib = require('zlib');

/**
 * Générateur d'icônes de barre d'état, en PNG, sans aucune dépendance ni
 * fichier binaire versionné.
 *
 * Pourquoi ne pas simplement livrer un .png ? Parce que l'icône doit refléter
 * l'état : sur Windows et Linux, la barre d'état n'affiche pas de texte à côté
 * de l'icône (contrairement à macOS et `setTitle`). Le seul moyen d'y donner
 * une information d'un coup d'œil est donc de la DESSINER dans l'icône. On
 * peint ici une petite jauge dont le remplissage suit la consommation.
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode un buffer RGBA (w*h*4) en PNG. */
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 6; // RGBA
  // Chaque scanline est préfixée de son octet de filtre (0 = aucun).
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Dessine le symbole TRACE : un trait d'enregistreur graphique, surmonté
 * d'une jauge de remplissage.
 *
 * @param {number} size      côté en pixels (22 en 1x, 44 en 2x)
 * @param {number} fill      0..1, part de la jauge remplie (null => pas de jauge)
 * @param {boolean} template macOS : icône monochrome noir+alpha, teintée par le système
 * @param {Array} tint       couleur RGB hors mode template
 */
function drawTrayIcon(size, fill = null, template = true, tint = [255, 180, 84]) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const s = size / 22; // échelle depuis la grille de référence 22x22
  const [r, g, b] = template ? [0, 0, 0] : tint;

  const px = (x, y, a) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const prev = rgba[i + 3];
    const alpha = Math.max(prev, Math.min(255, Math.round(a * 255)));
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = alpha;
  };

  const rect = (x0, y0, w, h, a = 1) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(x0 + x, y0 + y, a);
  };

  // --- Le tracé : une courbe échantillonnée, comme un stylet sur le papier.
  const points = [0.08, 0.5, 0.26, 0.82, 0.44, 0.14, 0.63, 0.66, 0.92, 0.34];
  const traceTop = 3.5 * s;
  const traceH = 11 * s;
  const thickness = Math.max(2, Math.round(2.4 * s));

  for (let i = 0; i < points.length - 2; i += 2) {
    const x1 = points[i] * size;
    const y1 = traceTop + (1 - points[i + 1]) * traceH;
    const x2 = points[i + 2] * size;
    const y2 = traceTop + (1 - points[i + 3]) * traceH;
    const steps = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 3));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      // Trait épaissi verticalement ET horizontalement : sur une pente raide,
      // un épaississement uniquement vertical laisse la ligne maigre.
      for (let d = 0; d < thickness; d++) {
        px(x, y + d, 1);
        px(x + 0.5, y + d, 1);
      }
    }
  }

  // --- La jauge d'état, en pied d'icône.
  if (fill != null) {
    const barY = Math.round(17.5 * s);
    const barH = Math.max(1, Math.round(1.8 * s));
    const barX = Math.round(1.5 * s);
    const barW = Math.round(19 * s);
    rect(barX, barY, barW, barH, 0.22); // rail
    const filled = Math.round(barW * Math.max(0, Math.min(1, fill)));
    if (filled > 0) rect(barX, barY, filled, barH, 1);
  }

  return encodePng(rgba, size, size);
}

/**
 * Icône applicative : une tuile graphite au coin arrondi, traversée par le
 * tracé ambre. Même vocabulaire que l'icône de barre d'état, mais avec un
 * fond — une icône de Dock ou de menu Démarrer doit tenir sur n'importe quel
 * papier peint.
 */
function drawAppIcon(size = 1024) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const radius = size * 0.22;
  const bg = [20, 22, 26];
  const trace = [255, 180, 84];

  const set = (x, y, c, a) => {
    const i = (y * size + x) * 4;
    // Composition « source-over » sur ce qui est déjà peint.
    const sa = a;
    const da = rgba[i + 3] / 255;
    const out = sa + da * (1 - sa);
    if (out <= 0) return;
    for (let k = 0; k < 3; k++) rgba[i + k] = Math.round((c[k] * sa + rgba[i + k] * da * (1 - sa)) / out);
    rgba[i + 3] = Math.round(out * 255);
  };

  // Fond : rectangle à coins arrondis, avec un lissage sur le rayon.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x, x - (size - radius), 0);
      const dy = Math.max(radius - y, y - (size - radius), 0);
      const d = Math.hypot(dx, dy);
      const a = d <= radius - 1 ? 1 : d >= radius + 1 ? 0 : (radius + 1 - d) / 2;
      if (a > 0) set(x, y, bg, a);
    }
  }

  // Lignes de grille du papier.
  for (let i = 1; i < 4; i++) {
    const y = Math.round(size * (0.3 + i * 0.12));
    for (let x = Math.round(size * 0.14); x < size * 0.86; x++) set(x, y, [255, 255, 255], 0.07);
  }

  // Le tracé.
  const pts = [0.14, 0.42, 0.3, 0.66, 0.44, 0.28, 0.58, 0.58, 0.72, 0.36, 0.86, 0.52];
  const w = Math.max(2, size * 0.035);
  for (let i = 0; i < pts.length - 2; i += 2) {
    const x1 = pts[i] * size;
    const y1 = size * (0.78 - pts[i + 1] * 0.5);
    const x2 = pts[i + 2] * size;
    const y2 = size * (0.78 - pts[i + 3] * 0.5);
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const cx = x1 + (x2 - x1) * t;
      const cy = y1 + (y2 - y1) * t;
      const r = w / 2;
      for (let oy = -Math.ceil(r); oy <= Math.ceil(r); oy++) {
        for (let ox = -Math.ceil(r); ox <= Math.ceil(r); ox++) {
          const d = Math.hypot(ox, oy);
          if (d > r + 0.7) continue;
          const px2 = Math.round(cx + ox);
          const py2 = Math.round(cy + oy);
          if (px2 < 0 || py2 < 0 || px2 >= size || py2 >= size) continue;
          set(px2, py2, trace, d <= r - 0.5 ? 1 : Math.max(0, r + 0.7 - d) / 1.2);
        }
      }
    }
  }

  return encodePng(rgba, size, size);
}

module.exports = { drawTrayIcon, drawAppIcon, encodePng };
