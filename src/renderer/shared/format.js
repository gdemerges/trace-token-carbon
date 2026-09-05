/**
 * Formatage — unités abrégées, chiffres compacts.
 *
 * Les unités elles-mêmes (Md, kg, kWh, L) ne se traduisent pas : ce sont des
 * symboles SI, identiques dans les deux langues. Ce qui change, c'est la
 * séparation des milliers et la virgule décimale — d'où `Intl`, alimenté par
 * la langue retenue et non plus par un « fr-FR » en dur.
 */

import { t, intl } from './i18n.js';

export const nf = (n, d = 0) =>
  new Intl.NumberFormat(intl(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);

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

/**
 * Volume d'eau. Les ordres de grandeur vont du millilitre (une requête) au
 * mètre cube (un mois d'usage soutenu) : l'unité suit, sinon on lit « 0,003 »
 * ou « 1 240 » sans jamais avoir d'intuition.
 */
export function water(litres) {
  litres = litres || 0;
  if (litres >= 1000) return `${nf(litres / 1000, 1)} m³`;
  if (litres >= 1) return `${nf(litres, litres >= 100 ? 0 : 1)} L`;
  return `${nf(litres * 1000, 0)} mL`;
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
  if (h >= 24) return t('fmt.hoursMinutesLong', { d: Math.floor(h / 24), h: h % 24 });
  if (h > 0) return t('duration.hoursMinutes', { h, m: String(m).padStart(2, '0') });
  return t('duration.minutes', { n: m });
}

/**
 * Libellé d'échéance d'une jauge. Trois cas, et aucun ne doit mentir :
 * une échéance à venir, une fenêtre glissante que l'on estime, ou une donnée
 * fournisseur périmée dont on assume l'ancienneté.
 */
export function windowLabel(g) {
  const left = until(g.resetsAt);
  if (left) return t('fmt.resetIn', { when: left });
  // On ne cite l'âge du relevé que s'il est encore ce qu'on affiche. Une
  // fenêtre expirée a été recalculée depuis : parler d'un « relevé il y a
  // 1 mois » ferait croire à un chiffre périmé alors qu'il est à jour.
  if (g.reportedAt && (g.limitSource === 'provider' || g.limitSource === 'live-stale')) return t('fmt.readAt', { when: ago(g.reportedAt) });
  if (g.limitSource === 'reset') return t('fmt.resetSince');
  return t('fmt.rolling');
}

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return t('fmt.ago.now');
  if (s < 60) return t('fmt.ago.seconds', { n: s });
  if (s < 3600) return t('fmt.ago.minutes', { n: Math.floor(s / 60) });
  if (s < 86400) return t('fmt.ago.hours', { n: Math.floor(s / 3600) });
  const d = Math.floor(s / 86400);
  if (d < 31) return t('fmt.ago.days', { n: d });
  const mo = Math.floor(d / 30);
  return mo < 12 ? t('fmt.ago.months', { n: mo }) : t('fmt.ago.years', { n: Math.floor(d / 365) });
}

/**
 * Date d'axe, jour et mois seulement.
 *
 * L'ordre suit la langue : « 05/09 » se lit 5 septembre en français et
 * 9 mai en anglais. Écrire le format en dur revenait à afficher une date
 * fausse à la moitié des lecteurs.
 */
export const shortDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(intl(), { month: '2-digit', day: '2-digit' }).format(new Date(y, m - 1, d));
};

/** Fourchette d'estimation carbone, resserrée en une seule chaîne lisible. */
export const range = (min, max, fmt) => `${fmt(min)} – ${fmt(max)}`;

export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
