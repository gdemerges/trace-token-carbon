'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const i18n = require('../src/i18n');

const fr = require('../src/i18n/fr.json');
const en = require('../src/i18n/en.json');

/** Tous les fichiers de source, pour y chercher les clés employées. */
function sourceFiles(dir = path.join(__dirname, '..', 'src'), out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Intégrité des catalogues
// ---------------------------------------------------------------------------

test('catalogues : les deux langues portent exactement les mêmes clés', () => {
  const manquantEn = Object.keys(fr).filter((k) => !(k in en));
  const manquantFr = Object.keys(en).filter((k) => !(k in fr));
  assert.deepEqual(manquantEn, [], 'clés absentes de l’anglais');
  assert.deepEqual(manquantFr, [], 'clés absentes du français');
  assert.ok(Object.keys(fr).length > 150, 'le catalogue couvre bien toute l’interface');
});

test('catalogues : une entrée au pluriel l’est dans les deux langues', () => {
  for (const k of Object.keys(fr)) {
    assert.equal(
      typeof fr[k] === 'object',
      typeof en[k] === 'object',
      `${k} : forme différente d’une langue à l’autre`
    );
    if (typeof fr[k] === 'object') {
      for (const lang of [fr, en]) {
        assert.ok(lang[k].one != null && lang[k].other != null, `${k} : il manque une forme`);
      }
    }
  }
});

test('catalogues : les paramètres d’une chaîne sont les mêmes dans les deux langues', () => {
  // Une traduction qui perd un `{n}` affiche une phrase amputée sans que rien
  // ne le signale : c'est le défaut le plus discret d'un catalogue.
  const params = (v) => new Set(String(typeof v === 'object' ? `${v.one} ${v.other}` : v).match(/\{\w+\}/g) || []);
  for (const k of Object.keys(fr)) {
    assert.deepEqual([...params(fr[k])].sort(), [...params(en[k])].sort(), `${k} : paramètres dépareillés`);
  }
});

test('catalogues : aucune traduction anglaise laissée vide', () => {
  for (const [k, v] of Object.entries(en)) {
    if (k === 'method.frenchNotes') continue; // vide côté français, par construction
    const text = typeof v === 'object' ? v.one : v;
    assert.ok(String(text).trim().length > 0, `${k} : traduction vide`);
  }
});

// ---------------------------------------------------------------------------
// Clés employées par le code
// ---------------------------------------------------------------------------

test('catalogues : toute clé employée dans le code existe', () => {
  // Le filet essentiel : une clé mal orthographiée s'affiche telle quelle à
  // l'écran, et aucun autre test ne la verrait.
  const used = new Set();
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-z][\w.-]*)'/gi)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-title|-aria)?="([\w.-]+)"/g)) used.add(m[1]);
  }
  const orphelines = [...used].filter((k) => !(k in fr));
  assert.deepEqual(orphelines, [], 'clés employées mais absentes du catalogue');
  assert.ok(used.size > 100, `seulement ${used.size} clés repérées : l’extraction a-t-elle cessé de fonctionner ?`);
});

// ---------------------------------------------------------------------------
// Choix de la langue
// ---------------------------------------------------------------------------

test('langue : le réglage explicite l’emporte sur le système', () => {
  assert.equal(i18n.resolveLocale('en', 'fr-FR'), 'en');
  assert.equal(i18n.resolveLocale('fr', 'en-US'), 'fr');
});

test('langue : « auto » suit le système, et retombe sur le français', () => {
  assert.equal(i18n.resolveLocale('auto', 'en-GB'), 'en');
  assert.equal(i18n.resolveLocale('auto', 'fr_CA.UTF-8'), 'fr');
  assert.equal(i18n.resolveLocale('auto', 'de-DE'), 'fr', 'langue non couverte : repli, pas d’erreur');
  assert.equal(i18n.resolveLocale(null, ''), 'fr');
  assert.equal(i18n.resolveLocale('klingon', 'de'), 'fr');
});

// ---------------------------------------------------------------------------
// Traduction
// ---------------------------------------------------------------------------

test('traduction : les paramètres sont substitués', () => {
  const t = i18n.makeT({ 'x.y': 'il reste {n} jours sur {total}' });
  assert.equal(t('x.y', { n: 3, total: 7 }), 'il reste 3 jours sur 7');
});

test('traduction : un paramètre absent laisse le gabarit visible plutôt qu’un trou', () => {
  const t = i18n.makeT({ 'x.y': '{a} et {b}' });
  assert.equal(t('x.y', { a: 'ceci' }), 'ceci et {b}');
});

test('traduction : une clé inconnue renvoie la clé', () => {
  assert.equal(i18n.makeT({})('jamais.vu'), 'jamais.vu', 'réparable à l’œil, contrairement à une chaîne vide');
});

test('traduction : le pluriel suit `n`', () => {
  const t = i18n.makeT({ j: { one: '{n} jour', other: '{n} jours' } });
  assert.equal(t('j', { n: 1 }), '1 jour');
  assert.equal(t('j', { n: 2 }), '2 jours');
  assert.equal(t('j', { n: 0 }), '0 jours');
});

test('traduction : le zéro peut rester au singulier là où la langue l’exige', () => {
  const t = i18n.makeT({ j: { one: '{n} jour', other: '{n} jours', plural_zero: false } });
  assert.equal(t('j', { n: 0 }), '0 jour');
});

test('traduction : chaque langue a son étiquette Intl', () => {
  assert.equal(i18n.forLocale('fr').intlLocale, 'fr-FR');
  assert.equal(i18n.forLocale('en').intlLocale, 'en-US');
  assert.equal(i18n.forLocale('xx').locale, 'fr', 'une langue inconnue retombe sur le français');
});

test('traduction : la langue du processus se fixe et se relit', (t) => {
  const before = i18n.currentLocale().locale;
  t.after(() => i18n.setLocale(before));

  i18n.setLocale('en');
  assert.equal(i18n.currentLocale().locale, 'en');
  assert.equal(i18n.t('menu.quit'), 'Quit TRACE');

  i18n.setLocale('fr');
  assert.equal(i18n.t('menu.quit'), 'Quitter TRACE');
});
