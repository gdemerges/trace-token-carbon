'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { primaryGauge, trayTitle, trayTooltip, durationLabel, snapshotFor } = require('../src/main/present');

const snapWith = (gauges, totals = {}) => ({
  gauges,
  range: { days: 30, all: false },
  report: {
    totals: {
      tokens: { total: 1_500_000_000 },
      costUSD: 314.07,
      carbon: { gramsCO2e: { mid: 26_900 } },
      ...totals,
    },
  },
});

const g = (over = {}) => ({ id: 'x', label: 'Session 5 h', fullLabel: 'Claude — session 5 h', percent: 40, windowHours: 5, ...over });

// ---------------------------------------------------------------------------
// Choix de la jauge affichée
// ---------------------------------------------------------------------------

test('barre : la jauge la plus remplie est celle qui s’affiche', () => {
  const snap = snapWith([g({ id: 'a', percent: 20 }), g({ id: 'b', percent: 71 }), g({ id: 'c', percent: 55 })]);
  assert.equal(primaryGauge(snap).id, 'b');
});

test('barre : à égalité, la fenêtre la plus courte l’emporte', () => {
  // C'est elle qui bloquera en premier : l'afficher est le seul choix utile.
  const snap = snapWith([g({ id: 'semaine', percent: 60, windowHours: 168 }), g({ id: 'session', percent: 60, windowHours: 5 })]);
  assert.equal(primaryGauge(snap).id, 'session');
});

test('barre : une jauge sans pourcentage n’est jamais choisie', () => {
  assert.equal(primaryGauge(snapWith([g({ percent: null })])), null);
  assert.equal(primaryGauge(snapWith([])), null);
  assert.equal(primaryGauge(null), null);
});

// ---------------------------------------------------------------------------
// Titre
// ---------------------------------------------------------------------------

test('barre : chaque métrique a son format compact', () => {
  const snap = snapWith([g({ percent: 71.4 })]);
  assert.equal(trayTitle(snap, { trayMetric: 'session' }), '71 %');
  assert.equal(trayTitle(snap, { trayMetric: 'tokens' }), '1.5 Md');
  assert.equal(trayTitle(snap, { trayMetric: 'cost' }), '$314');
  assert.equal(trayTitle(snap, { trayMetric: 'carbon' }), '26.9 kg');
});

test('barre : sans échelle sûre, un tiret plutôt qu’un zéro inventé', () => {
  assert.equal(trayTitle(snapWith([g({ percent: null })]), { trayMetric: 'session' }), '—');
  assert.equal(trayTitle(null, {}), '');
});

test('barre : les tokens passent au milliard sans changer de largeur', () => {
  const petit = snapWith([], { tokens: { total: 4_200_000 } });
  assert.equal(trayTitle(petit, { trayMetric: 'tokens' }), '4 M');
});

// ---------------------------------------------------------------------------
// Infobulle
// ---------------------------------------------------------------------------

test('infobulle : une ligne par fenêtre, puis le total de la période', () => {
  const snap = snapWith([g({ percent: 40 }), g({ fullLabel: 'Claude — hebdomadaire', percent: null })]);
  const lines = trayTooltip(snap).split('\n');
  assert.equal(lines[0], 'TRACE');
  assert.equal(lines[1], 'Claude — session 5 h : 40 %');
  assert.equal(lines[2], 'Claude — hebdomadaire : —');
  assert.match(lines[3], /^30 j : \$314\.07 · 26\.9 kg CO₂e$/);
});

test('infobulle : la trajectoire y figure quand elle précède la réinitialisation', () => {
  const snap = snapWith([g({ projection: { inMs: 95 * 60000, beforeReset: true } })]);
  assert.match(trayTooltip(snap), /pleine dans 1 h 35/);
});

test('infobulle : une saturation après réinitialisation ne s’affiche pas', () => {
  const snap = snapWith([g({ projection: { inMs: 95 * 60000, beforeReset: false } })]);
  assert.doesNotMatch(trayTooltip(snap), /pleine dans/);
});

test('durées : les trois échelles sont couvertes', () => {
  assert.equal(durationLabel(42 * 60000), '42 min');
  assert.equal(durationLabel(3 * 3600000 + 10 * 60000), '3 h 10');
  assert.equal(durationLabel(50 * 3600000), '2 j');
  assert.equal(durationLabel(0), 'un instant');
  assert.equal(durationLabel(NaN), 'un instant');
});

// ---------------------------------------------------------------------------
// Période par fenêtre
// ---------------------------------------------------------------------------

test('période : chaque fenêtre reçoit la sienne, pas celle par défaut', () => {
  // La faute d'origine : le rafraîchissement de fond diffusait la période par
  // défaut à tout le monde, et une vue « 1 an » retombait à 30 jours toute
  // seule pendant que le sélecteur affichait toujours « 1 an ».
  const snap = snapWith([]);
  let demande = null;
  const out = snapshotFor({}, snap, 365, (_s, o) => { demande = o.days; return { recalcule: true }; });
  assert.deepEqual(out, { recalcule: true });
  assert.equal(demande, 365);
});

test('période : identique à celle déjà calculée, on ne recalcule pas', () => {
  const snap = snapWith([]);
  assert.equal(snapshotFor({}, snap, 30, () => assert.fail('aucun recalcul attendu')), snap);
  assert.equal(snapshotFor({}, snap, undefined, () => assert.fail('aucun recalcul attendu')), snap);
});

test('période : « tout l’historique » ne se compare pas à un nombre de jours', () => {
  // `days: 'all'` ne vaudra jamais `range.days`, qui porte la profondeur
  // réelle des données : sans ce cas, l'instantané complet était recalculé à
  // chaque diffusion, pour un résultat identique.
  const snap = { ...snapWith([]), range: { days: 193, all: true } };
  assert.equal(snapshotFor({}, snap, 'all', () => assert.fail('aucun recalcul attendu')), snap);
});

test('période : sans état chargé, on renvoie ce qu’on a', () => {
  assert.equal(snapshotFor(null, 'instantané', 365, () => assert.fail('rien à calculer')), 'instantané');
});
