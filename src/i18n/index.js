'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Traduction.
 *
 * TRACE était intégralement en français, en dur, jusque dans les messages
 * d'erreur des collecteurs. Extraire les chaînes coûte d'autant moins cher
 * qu'on le fait tôt : chaque écran ajouté d'ici là serait un écran de plus à
 * reprendre.
 *
 * Trois partis pris :
 *
 *  1. **Une seule source, deux formats.** Les catalogues sont des fichiers
 *     JSON. Le cœur et le processus principal les lisent avec `require` ; le
 *     renderer, qui tourne en module ES sous `file://` où `fetch` est bloqué,
 *     les reçoit par IPC. Pas de duplication, pas de bundler.
 *
 *  2. **Une clé manquante affiche la clé, elle ne casse rien.** Un écran qui
 *     montre `gauges.empty` est réparable ; un écran blanc ne l'est pas. Un
 *     test vérifie de toute façon que les deux catalogues portent exactement
 *     les mêmes clés, et que toute clé employée dans le code existe.
 *
 *  3. **Le français reste la langue de référence.** C'est celle dans laquelle
 *     les textes ont été pensés, et celle qui sert de repli. L'anglais en est
 *     la traduction, pas l'inverse.
 *
 * Ce qui n'est PAS traduit, et pourquoi : l'annexe méthodologique du carbone
 * (`carbon/factors.js`, `carbon/sources.js`). Ce sont des citations, des
 * réserves d'usage et des notes destinées à un livrable auditable, encore en
 * cours de figeage. Les traduire vite en ferait deux versions à maintenir dont
 * une non relue — exactement le genre de fausse précision que ce module refuse
 * partout ailleurs.
 */

const DEFAULT_LOCALE = 'fr';
const SUPPORTED = ['fr', 'en'];

/** Étiquette BCP 47 pour `Intl`, dérivée de la langue retenue. */
const INTL_LOCALE = { fr: 'fr-FR', en: 'en-US' };

const cache = new Map();

/**
 * Choisit la langue : le réglage explicite l'emporte, sinon celle du système,
 * sinon le français.
 *
 * @param {?string} configured  'fr' | 'en' | 'auto' | null
 * @param {?string} system      étiquette système, ex. 'en-GB'
 */
function resolveLocale(configured, system) {
  if (configured && configured !== 'auto') {
    const want = String(configured).slice(0, 2).toLowerCase();
    if (SUPPORTED.includes(want)) return want;
  }
  const sys = String(system || '').slice(0, 2).toLowerCase();
  return SUPPORTED.includes(sys) ? sys : DEFAULT_LOCALE;
}

/** Charge un catalogue, une fois par processus. */
function load(locale) {
  const key = SUPPORTED.includes(locale) ? locale : DEFAULT_LOCALE;
  if (cache.has(key)) return cache.get(key);
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, `${key}.json`), 'utf8'));
  cache.set(key, raw);
  return raw;
}

/**
 * Substitue les paramètres nommés : `{n} jours` + `{n: 3}` → « 3 jours ».
 *
 * Aucune interprétation au-delà : ni HTML, ni format. Les chaînes traduites
 * sont insérées telles quelles dans du texte, et échappées par l'appelant
 * quand elles vont dans du balisage.
 */
function interpolate(template, params) {
  if (!params) return template;
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/**
 * Fabrique la fonction de traduction.
 *
 * Le pluriel suit la règle la plus simple qui couvre le français et l'anglais :
 * une forme au singulier, une au pluriel, choisies sur `params.n`. Le français
 * met zéro au singulier, l'anglais au pluriel — d'où le choix porté par le
 * catalogue (`plural_zero`) plutôt que codé ici.
 */
function makeT(catalog) {
  return function t(key, params) {
    let entry = catalog[key];
    if (entry == null) return key;

    if (typeof entry === 'object') {
      const n = params && Number(params.n);
      const zeroIsPlural = entry.plural_zero !== false;
      const plural = Number.isFinite(n) ? (n === 0 ? zeroIsPlural : Math.abs(n) > 1) : false;
      entry = plural ? entry.other : entry.one;
    }
    return interpolate(entry, params);
  };
}

/**
 * Langue courante du processus.
 *
 * État global assumé. L'alternative — passer un `t` à chaque fonction du cœur,
 * des collecteurs et des jauges — traverserait une trentaine de signatures
 * pour une valeur qui ne change qu'au réglage, et qui est la même pour toute
 * l'application. Le processus principal la fixe au démarrage et à chaque
 * changement de réglage ; la CLI la fixe une fois. Le renderer, lui, n'utilise
 * pas cet état : il reçoit son catalogue par IPC.
 */
let current = forLocale(DEFAULT_LOCALE);

/** Fixe la langue du processus. Renvoie la langue effectivement retenue. */
function setLocale(locale) {
  current = forLocale(locale);
  return current.locale;
}

/** Traduit dans la langue courante du processus. */
function t(key, params) {
  return current.t(key, params);
}

/** Langue courante, et son étiquette `Intl`. */
function currentLocale() {
  return { locale: current.locale, intlLocale: current.intlLocale };
}

/** Catalogue courant, tel qu'il part vers le renderer. */
function currentStrings() {
  return { locale: current.locale, intlLocale: current.intlLocale, strings: current.strings };
}

/** Raccourci : catalogue chargé et fonction prête, pour une langue donnée. */
function forLocale(locale) {
  const resolved = SUPPORTED.includes(locale) ? locale : DEFAULT_LOCALE;
  const catalog = load(resolved);
  return { locale: resolved, intlLocale: INTL_LOCALE[resolved], strings: catalog, t: makeT(catalog) };
}

module.exports = {
  DEFAULT_LOCALE,
  SUPPORTED,
  INTL_LOCALE,
  resolveLocale,
  load,
  makeT,
  interpolate,
  forLocale,
  setLocale,
  t,
  currentLocale,
  currentStrings,
};
