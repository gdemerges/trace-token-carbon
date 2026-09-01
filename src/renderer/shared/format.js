/** Formatage — tout en français, unités abrégées, chiffres compacts. */

export const nf = (n, d = 0) =>
  new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);

/** Volumes de tokens : on ne lit jamais « 1 304 649 958 » d'un coup d'œil. */
export function tokens(n) {
  n = n || 0;
  if (n >= 1e9) return `${nf(n / 1e9, 2)} Md`;
  if (n >= 1e6) return `${nf(n / 1e6, 1)} M`;
  if (n >= 1e3) return `${nf(n / 1e3, 1)} k`;
  return nf(n);
}

export function usd(n) {
  if (n == null) return '—';
  if (n >= 1000) return `$${nf(n, 0)}`;
  if (n >= 1) return `$${nf(n, 2)}`;
  return `$${nf(n, n >= 0.01 ? 3 : 4)}`;
}

/** Masse de CO₂e, avec l'unité qui garde 2-3 chiffres significatifs. */
export function co2(grams) {
  grams = grams || 0;
  if (grams >= 1e6) return `${nf(grams / 1e6, 2)} t`;
  if (grams >= 1000) return `${nf(grams / 1000, grams >= 10000 ? 0 : 1)} kg`;
  if (grams >= 1) return `${nf(grams, grams >= 100 ? 0 : 1)} g`;
  return `${nf(grams * 1000, 0)} mg`;
}

export function energy(wh) {
  wh = wh || 0;
  if (wh >= 1000) return `${nf(wh / 1000, 1)} kWh`;
  if (wh >= 1) return `${nf(wh, 1)} Wh`;
  return `${nf(wh * 1000, 0)} mWh`;
}

export const pct = (n, d = 0) => (n == null ? '—' : `${nf(n, d)} %`);

/**
 * Durée restante avant réinitialisation d'une fenêtre.
 * Renvoie null si l'échéance est déjà passée — dire « réinit. dans maintenant »
 * pour une donnée vieille de trois semaines serait faux.
 */
export function until(ts) {
  if (!ts) return null;
  const ms = ts - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)} j ${h % 24} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')}`;
  return `${m} min`;
}

/**
 * Libellé d'échéance d'une jauge. Trois cas, et aucun ne doit mentir :
 * une échéance à venir, une fenêtre glissante que l'on estime, ou une donnée
 * fournisseur périmée dont on assume l'ancienneté.
 */
export function windowLabel(g) {
  const left = until(g.resetsAt);
  if (left) return `réinit. dans ${left}`;
  // On ne cite l'âge du relevé que s'il est encore ce qu'on affiche. Une
  // fenêtre expirée a été recalculée depuis : parler d'un « relevé il y a
  // 1 mois » ferait croire à un chiffre périmé alors qu'il est à jour.
  if (g.reportedAt && (g.limitSource === 'provider' || g.limitSource === 'live-stale')) return `relevé ${ago(g.reportedAt)}`;
  if (g.limitSource === 'reset') return 'réinitialisée depuis';
  return 'fenêtre glissante';
}

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  if (d < 31) return `il y a ${d} j`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `il y a ${mo} mois` : `il y a ${Math.floor(d / 365)} an(s)`;
}

export const shortDate = (iso) => {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
};

/** Fourchette d'estimation carbone, resserrée en une seule chaîne lisible. */
export const range = (min, max, fmt) => `${fmt(min)} – ${fmt(max)}`;

export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
