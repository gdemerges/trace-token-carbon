/**
 * Traduction côté interface.
 *
 * Le renderer n'a aucun accès au système de fichiers — c'est délibéré, les
 * journaux analysés contiennent le code et les conversations de
 * l'utilisateur. Il ne peut donc pas lire les catalogues, et `fetch` est de
 * toute façon bloqué sous `file://`. Le processus principal les lui envoie
 * une fois, à l'ouverture, par le pont IPC.
 *
 * Conséquence à respecter : `initI18n` doit être attendu AVANT le premier
 * rendu. Un écran peint avant l'arrivée du catalogue afficherait des clés
 * brutes, puis se corrigerait — un clignotement que personne n'a demandé.
 */

let catalog = {};
let intlLocale = 'fr-FR';
let locale = 'fr';

/** Reçoit le catalogue envoyé par le processus principal. */
export function initI18n(payload) {
  if (!payload) return;
  catalog = payload.strings || {};
  intlLocale = payload.intlLocale || 'fr-FR';
  locale = payload.locale || 'fr';
}

/** Étiquette `Intl`, pour les formats de nombres et de dates. */
export const intl = () => intlLocale;
export const lang = () => locale;

/**
 * Traduit. Une clé absente renvoie la clé : réparable à l'œil, là où une
 * chaîne vide laisserait un trou inexplicable dans l'écran.
 */
export function t(key, params) {
  let entry = catalog[key];
  if (entry == null) return key;

  if (typeof entry === 'object') {
    const n = params && Number(params.n);
    const zeroIsPlural = entry.plural_zero !== false;
    const plural = Number.isFinite(n) ? (n === 0 ? zeroIsPlural : Math.abs(n) > 1) : false;
    entry = plural ? entry.other : entry.one;
  }
  if (!params) return entry;
  return String(entry).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/**
 * Traduit le balisage statique.
 *
 * Les deux pages portent du texte écrit à la main dans le HTML — un bouton,
 * un titre, un `aria-label`. Plutôt que de le reconstruire en JavaScript, on
 * l'annote (`data-i18n`, `data-i18n-title`, `data-i18n-aria`) et on le
 * remplace au chargement. Le HTML reste lisible, et la version française y
 * demeure visible comme repli si le catalogue n'arrivait pas.
 */
export function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}
