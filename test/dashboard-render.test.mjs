// Le tableau de bord, monté pour de bon dans un DOM.
//
// Les autres tests couvrent les modules partagés et les catalogues ; aucun ne
// peignait un écran. Une exception dans `render()` vide la page sans qu'aucun
// test ne rougisse — le renderer la remonte au journal, où personne ne lit.
// Ce test monte `dashboard.js` sur un instantané de référence (`fixtures/`,
// anonymisé, au format exact que produit le cœur) et vérifie que les cartes
// se dessinent.
//
// Régénérer l'instantané quand la forme du JSON change :
//   cargo run -p trace-core --example dump -- snapshot
// puis anonymiser les noms de projets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../src/renderer/dashboard/index.html').replace(/<script[\s\S]*?<\/script>/g, '');

const INTL = { fr: 'fr-FR', en: 'en-US' };
let generation = 0;

/** Monte le tableau de bord et rend le document une fois le premier rendu fini. */
async function mount({ locale = 'fr', mutate = () => {} } = {}) {
  const snapshot = JSON.parse(read('./fixtures/snapshot.json'));
  mutate(snapshot);

  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  window.trace = {
    getStrings: async () => ({
      locale,
      intlLocale: INTL[locale],
      strings: JSON.parse(read(`../src/i18n/${locale}.json`)),
    }),
    getSnapshot: async () => snapshot,
    getConfig: async () => snapshot.config,
    onUpdate: () => () => {},
    refresh: async () => snapshot,
    exportCsv: async () => ({ ok: true, rows: 1, filePath: 'C:\\x\\a.csv' }),
    exportReport: async () => ({ ok: true, filePath: 'C:\\x\\r.md' }),
    setConfig: async () => ({}),
    setKey: async () => ({ ok: true }),
    openExternal: () => {},
    quit: () => {},
  };

  // Le module lit ces globaux à l'import : on les pose avant, et on les retire
  // ensuite pour ne pas fuir d'un test à l'autre.
  const names = ['window', 'document', 'requestAnimationFrame', 'HTMLElement', 'Node'];
  const previous = Object.fromEntries(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  for (const n of names) {
    Object.defineProperty(globalThis, n, { value: n === 'window' ? window : window[n] ?? window.document, configurable: true, writable: true });
  }
  globalThis.document = window.document;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  // `dashboard.js` rafraîchit « à l'instant » toutes les 5 s : une minuterie
  // vivante tiendrait le processus de test ouvert indéfiniment.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => realSetInterval(...args).unref();

  // Une instance de module neuve par montage : `dashboard.js` garde son état.
  await import(`../src/renderer/dashboard/dashboard.js?mount=${++generation}`);
  for (let i = 0; i < 50 && !window.document.querySelector('#main').children.length; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  // Le graphique du héros se dessine dans une frame d'affichage : on la laisse
  // passer AVANT de rendre les globaux, sinon elle s'exécute sans `document`.
  await new Promise((r) => setTimeout(r, 30));

  const restore = () => {
    globalThis.setInterval = realSetInterval;
    for (const n of names) {
      if (previous[n]) Object.defineProperty(globalThis, n, previous[n]);
      else delete globalThis[n];
    }
    window.close();
  };
  return { document: window.document, errors, restore };
}

test('le tableau de bord se peint : héros, cartes, aucune exception', async () => {
  const ui = await mount();
  try {
    assert.equal(ui.errors.length, 0, ui.errors.join(' | '));
    assert.equal(ui.document.querySelectorAll('#figures .fig').length, 4);
    assert.ok(ui.document.querySelector('#hero-strip svg'), 'le graphique du héros est dessiné');
    const titles = [...ui.document.querySelectorAll('#main .card > h2')].map((h) => h.textContent);
    assert.ok(titles.length >= 6, `cartes peintes : ${titles.join(', ')}`);
  } finally {
    ui.restore();
  }
});

test('la carte de budget affiche dépense, plafond et projection', async () => {
  const ui = await mount();
  try {
    const card = [...ui.document.querySelectorAll('#main .card')].find((c) =>
      c.querySelector('h2')?.textContent.startsWith('Budget mensuel'),
    );
    assert.ok(card, 'la carte de budget est peinte');
    assert.ok(card.querySelector('.budget-bar'));
    assert.ok(card.querySelector('.budget-mark'), 'le repère de projection est posé');
    assert.match(card.textContent, /sur \$200/);
    assert.match(card.textContent, /en fin de mois/);
  } finally {
    ui.restore();
  }
});

test('sans plafond fixé, aucune carte de budget', async () => {
  const ui = await mount({ mutate: (s) => (s.budget = null) });
  try {
    assert.equal(ui.document.querySelector('.budget-bar'), null);
    assert.equal(ui.errors.length, 0, ui.errors.join(' | '));
  } finally {
    ui.restore();
  }
});

test('un dépassement se signale en couleur chaude, pas en gris', async () => {
  const ui = await mount({
    mutate: (s) => {
      s.budget.state = 'over';
      s.budget.percent = 130;
      s.budget.spentUSD = 260;
    },
  });
  try {
    assert.ok(ui.document.querySelector('.budget-fill.hot'));
    assert.match(ui.document.querySelector('.budget-line').textContent, /Budget dépassé/);
    // La barre ne déborde pas de sa piste.
    assert.equal(ui.document.querySelector('.budget-fill').style.width, '100%');
  } finally {
    ui.restore();
  }
});

test('les tableaux portent la variation contre la période précédente', async () => {
  const ui = await mount();
  try {
    const headers = [...ui.document.querySelectorAll('#main table th')].map((th) => th.textContent);
    assert.equal(headers.filter((h) => h === 'vs précédent').length, 2, 'modèles et projets');
    const cells = [...ui.document.querySelectorAll('#main td.num')].map((td) => td.textContent);
    assert.ok(cells.some((c) => c.includes('▲ 50 %')), 'hausse signalée');
    assert.ok(cells.some((c) => c.includes('▼ 50 %')), 'baisse signalée');
    assert.ok(cells.includes('nouveau'), 'un groupe sans homologue est « nouveau »');
  } finally {
    ui.restore();
  }
});

test('le tableau de bord se peint aussi en anglais', async () => {
  const ui = await mount({ locale: 'en' });
  try {
    assert.equal(ui.errors.length, 0, ui.errors.join(' | '));
    const titles = [...ui.document.querySelectorAll('#main .card > h2')].map((h) => h.textContent);
    assert.ok(titles.some((t) => t.startsWith('Monthly budget')), titles.join(', '));
  } finally {
    ui.restore();
  }
});

test('un nom de projet hostile reste inerte dans le DOM', async () => {
  const ui = await mount({
    mutate: (s) => {
      s.report.byProject[0].key = '<img src=x onerror=alert(1)>';
    },
  });
  try {
    assert.equal(ui.document.querySelector('#main img[src="x"]'), null, 'aucun <img> injecté');
    assert.ok(ui.document.body.textContent.includes('<img src=x onerror=alert(1)>'), 'affiché comme texte');
  } finally {
    ui.restore();
  }
});
