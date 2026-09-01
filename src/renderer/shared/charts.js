/**
 * Primitives graphiques en SVG écrit à la main — aucune librairie.
 *
 * Le choix n'est pas idéologique : les jeux de couleurs par défaut des
 * librairies de graphes casseraient le codage à trois teintes (ambre =
 * tokens, sarcelle = CO₂e, bleu = coût) qui fait tout l'intérêt de la lecture
 * rapide. Et 200 lignes de SVG pèsent moins qu'un Mo de dépendance.
 */

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};

/**
 * ÉLÉMENT SIGNATURE — la bande d'enregistrement.
 *
 * Une trace continue, tirée bord à bord comme le papier qui défile sous le
 * stylet d'un enregistreur graphique : pas de cadre, pas de marge, pas d'axes.
 * Le repère vertical à droite marque l'instant présent, là où le stylet écrit.
 */
export function traceStrip(container, series, opts = {}) {
  const w = opts.width || container.clientWidth || 360;
  // La hauteur vient du conteneur, pas d'un nombre écrit en dur côté JS :
  // sinon CSS et JS dérivent en silence et le tracé déborde sur ce qui suit.
  const h = opts.height || container.clientHeight || 56;
  const values = series.map((d) => opts.value ? opts.value(d) : d.tokens.total);
  const max = Math.max(1, ...values);

  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: '100%', preserveAspectRatio: 'none', role: 'img' });
  svg.setAttribute('aria-label', opts.label || 'Consommation sur la période');

  // Grille de fond : les lignes du papier millimétré.
  for (let i = 1; i < 4; i++) {
    svg.appendChild(el('line', { x1: 0, x2: w, y1: (h / 4) * i, y2: (h / 4) * i, stroke: 'var(--rule-soft)', 'stroke-width': 1 }));
  }

  // Marge basse plus généreuse que la haute : sur une série creuse la ligne
  // reste presque tout du long au plancher, et elle ne doit pas se confondre
  // avec le filet qui ferme la bande.
  const padTop = 5;
  const padBottom = 9;
  const x = (i) => (values.length <= 1 ? w / 2 : (i / (values.length - 1)) * w);
  const y = (v) => h - padBottom - (v / max) * (h - padTop - padBottom);

  const pts = values.map((v, i) => [x(i), y(v)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

  // Aire sous la courbe, très discrète : donne la masse sans voler la ligne.
  const area = `${line} L${w},${h} L0,${h} Z`;
  const color = opts.color || 'var(--tokens)';
  svg.appendChild(el('path', { d: area, fill: color, opacity: 0.1 }));
  svg.appendChild(el('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));

  // Le stylet : position courante.
  const last = pts[pts.length - 1];
  if (last) {
    svg.appendChild(el('line', { x1: last[0], x2: last[0], y1: 0, y2: h, stroke: color, 'stroke-width': 1, opacity: 0.35 }));
    svg.appendChild(el('circle', { cx: last[0], cy: last[1], r: 2.5, fill: color }));
  }

  container.replaceChildren(svg);
  return svg;
}

/**
 * Jauge à segments, dans l'esprit d'un VU-mètre : le remplissage est discret
 * et gradué, jamais une barre lisse à coins arrondis. On lit un niveau, on ne
 * regarde pas un chargement.
 */
export function gauge(container, percent, opts = {}) {
  const w0 = opts.width || container.clientWidth || 340;
  // On densifie les segments avec la largeur : à 32 segments sur un panneau
  // large, la jauge se lit comme un filet pointillé et plus comme un niveau.
  const segments = opts.segments || Math.max(24, Math.min(72, Math.round(w0 / 9)));
  const h = opts.height || 10;
  const gap = 1.5;
  const w = w0;
  const segW = (w - gap * (segments - 1)) / segments;

  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: h, preserveAspectRatio: 'none', role: 'img' });
  svg.setAttribute('aria-label', `${Math.round(percent || 0)} %`);

  const filled = percent == null ? 0 : (percent / 100) * segments;
  // Au-delà de 85 % la teinte bascule : le dépassement se voit sans lire.
  const color = percent != null && percent >= 85 ? 'var(--hot)' : opts.color || 'var(--tokens)';

  for (let i = 0; i < segments; i++) {
    const full = i < Math.floor(filled);
    const partial = !full && i < filled;
    // Sur une échelle approximative, un segment sur deux est évidé : la jauge
    // reste lisible mais annonce visuellement qu'elle n'est pas une mesure.
    const hollow = opts.approximate && full && i % 2 === 1;
    svg.appendChild(
      el('rect', {
        x: i * (segW + gap),
        y: hollow ? h * 0.3 : 0,
        width: segW,
        height: hollow ? h * 0.4 : h,
        rx: 1,
        fill: full ? color : partial ? color : 'var(--rule)',
        opacity: full ? (hollow ? 0.5 : 1) : partial ? 0.45 : 1,
      })
    );
  }
  container.replaceChildren(svg);
}

/** Barres horizontales empilées — répartition d'un total entre catégories. */
export function stackedBar(container, parts, opts = {}) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const h = opts.height || 8;
  const svg = el('svg', { viewBox: `0 0 100 ${h}`, width: '100%', height: h, preserveAspectRatio: 'none' });
  let x = 0;
  for (const p of parts) {
    const wpc = (p.value / total) * 100;
    if (wpc <= 0) continue;
    const r = el('rect', { x, y: 0, width: Math.max(wpc - 0.3, 0.4), height: h, rx: 1, fill: p.color });
    r.appendChild(el('title')).textContent = `${p.label} — ${Math.round(wpc)} %`;
    svg.appendChild(r);
    x += wpc;
  }
  container.replaceChildren(svg);
}

/** Histogramme vertical (série journalière ou répartition horaire). */
export function bars(container, data, opts = {}) {
  const h = opts.height || container.clientHeight || 120;
  const w = opts.width || container.clientWidth || 600;
  const max = Math.max(1, ...data.map((d) => d.value));
  const gap = data.length > 40 ? 1 : 2;
  const bw = Math.max(1, (w - gap * (data.length - 1)) / data.length);

  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: '100%', preserveAspectRatio: 'none' });
  data.forEach((d, i) => {
    const bh = Math.max(d.value > 0 ? 1.5 : 0, (d.value / max) * (h - 2));
    const rect = el('rect', {
      x: i * (bw + gap),
      y: h - bh,
      width: bw,
      height: bh,
      rx: bw > 3 ? 1.5 : 0,
      fill: d.color || opts.color || 'var(--tokens)',
      opacity: d.highlight ? 1 : 0.82,
    });
    if (d.title) rect.appendChild(el('title')).textContent = d.title;
    svg.appendChild(rect);
  });
  container.replaceChildren(svg);
}

/**
 * Fourchette d'incertitude : un segment min–max avec un repère médian.
 * Indispensable pour le carbone, dont les bornes couvrent un ordre de
 * grandeur — afficher un point unique laisserait croire à une mesure.
 */
export function rangeBar(container, min, mid, max, scaleMax, color = 'var(--carbon)') {
  const h = 14;
  const svg = el('svg', { viewBox: `0 0 100 ${h}`, width: '100%', height: h, preserveAspectRatio: 'none' });
  const s = (v) => Math.max(0, Math.min(100, (v / (scaleMax || max || 1)) * 100));
  svg.appendChild(el('rect', { x: 0, y: h / 2 - 1, width: 100, height: 2, fill: 'var(--rule)' }));
  svg.appendChild(el('rect', { x: s(min), y: h / 2 - 3, width: Math.max(0.6, s(max) - s(min)), height: 6, rx: 1, fill: color, opacity: 0.35 }));
  svg.appendChild(el('rect', { x: Math.min(99, s(mid)), y: 1, width: 1.4, height: h - 2, fill: color }));
  container.replaceChildren(svg);
}
