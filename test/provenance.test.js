'use strict';

const test = require('node:test');
const assert = require('node:assert');

const provenance = require('../src/core/provenance');
const { report, exportRows } = require('../src/core/aggregate');
const { computeGauges } = require('../src/core/ratelimits');
const collectors = require('../src/core/collectors');
const store = require('../src/core/store');
const core = require('../src/core');

const DAY = 86400000;

/** Événement de requête, tel qu'un collecteur local en produit. */
function local(ts, total, over = {}) {
  return {
    ts,
    source: 'claude-code',
    model: 'claude-sonnet-4-5',
    project: 'trace',
    session: 's1',
    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, total },
    requests: 1,
    ...over,
  };
}

/** Agrégat journalier, tel qu'un rapport d'organisation en produit. */
function billed(ts, total, over = {}) {
  return local(ts, total, { source: 'anthropic-api', project: null, session: null, authoritative: true, ...over });
}

/** Minuit local du jour décalé de `offset` jours. */
function midnight(offset = 0) {
  const d = new Date(Date.now() + offset * DAY);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Fusion : ajouter une requête, remplacer une journée
// ---------------------------------------------------------------------------

test('provenance : un agrégat journalier remplace le précédent au lieu de s’y ajouter', () => {
  const t = midnight();
  let acc = provenance.mergeDaily([], [billed(t, 1000)]);
  acc = provenance.mergeDaily(acc, [billed(t, 1500)]);
  acc = provenance.mergeDaily(acc, [billed(t, 2200)]);

  assert.equal(acc.length, 1, 'la journée en cours ne doit produire qu’une ligne');
  assert.equal(acc[0].tokens.total, 2200, 'le dernier relevé corrige le précédent');
});

test('provenance : un relevé vide n’efface pas l’historique déjà connu', () => {
  // Un collecteur en erreur renvoie une liste vide. Prendre cela pour « la
  // journée est à zéro » ferait disparaître l'historique facturé à la
  // première coupure réseau.
  const acc = provenance.mergeDaily([billed(midnight(-1), 5000)], []);
  assert.equal(acc.length, 1);
  assert.equal(acc[0].tokens.total, 5000);
});

test('provenance : le remplacement est cloisonné par jour, modèle et projet', () => {
  const t = midnight();
  const before = [
    billed(t, 1000, { model: 'claude-sonnet-4-5' }),
    billed(t, 400, { model: 'claude-opus-4-5' }),
    billed(t - DAY, 900, { model: 'claude-sonnet-4-5' }),
  ];
  const after = provenance.mergeDaily(before, [billed(t, 1600, { model: 'claude-sonnet-4-5' })]);

  assert.equal(after.length, 3, 'seule la ligne de même clé est remplacée');
  const sonnetToday = after.find((e) => e.model === 'claude-sonnet-4-5' && e.ts === t);
  assert.equal(sonnetToday.tokens.total, 1600);
  assert.equal(after.find((e) => e.model === 'claude-opus-4-5').tokens.total, 400, 'l’autre modèle est intact');
  assert.equal(after.find((e) => e.ts === t - DAY).tokens.total, 900, 'la veille est intacte');
});

test('provenance : trois relevés successifs de la journée en cours ne gonflent pas le total', async (t) => {
  // Le scénario exact qui produisait des chiffres faux : à une minute de
  // cadence, la journée courante finissait comptée plus de mille fois.
  const original = collectors.ALL.slice();
  t.after(() => {
    collectors.ALL.length = 0;
    collectors.ALL.push(...original);
  });

  const totals = [1000, 1500, 2200];
  let call = 0;
  collectors.ALL.length = 0;
  collectors.ALL.push({
    id: 'anthropic-api',
    label: 'API Anthropic',
    isAvailable: () => true,
    collect: () => ({ events: [billed(midnight(), totals[call++])], quota: [], state: {}, stats: {} }),
  });

  // Index fourni explicitement : le test ne doit ni lire ni écrire l'index
  // réel de la machine.
  let state = { index: { version: 2, collectors: {}, events: [], quota: [] } };
  for (let i = 0; i < totals.length; i++) {
    state = await core.refresh({ config: { ...store.DEFAULT_CONFIG }, index: state.index, persist: false });
  }

  assert.equal(state.events.length, 1, 'un seul agrégat pour la journée');
  const rep = report(state.events, { from: midnight() - DAY, to: Date.now() });
  assert.equal(rep.totals.tokens.total, 2200, 'le total suit le dernier relevé, il ne cumule pas les relevés');
});

// ---------------------------------------------------------------------------
// Doublon local / facturé
// ---------------------------------------------------------------------------

test('provenance : la mesure locale et le chiffre facturé ne s’additionnent pas', () => {
  const t = midnight() + 10 * 3600000;
  const events = [local(t, 1000), local(t + 60000, 500), billed(midnight(), 1600)];

  const rep = report(events, { from: midnight() - DAY, to: Date.now() });
  assert.equal(rep.totals.tokens.total, 1500, 'la mesure locale fait foi sur les jours qu’elle couvre');
  assert.equal(rep.billedDaysDropped, 1);
});

test('provenance : le chiffre facturé comble les jours que la machine n’a pas vus', () => {
  // Usage depuis une autre machine, ou avant l'installation de TRACE : sans
  // cette règle, la journée resterait vide alors que le fournisseur l'a
  // facturée.
  const events = [local(midnight() + 3600000, 1000), billed(midnight(-3), 8000)];

  const rep = report(events, { from: midnight(-10), to: Date.now() });
  assert.equal(rep.totals.tokens.total, 9000);
  assert.equal(rep.billedDaysDropped, 0);
});

test('provenance : les familles sont indépendantes', () => {
  // Une clé Admin OpenAI ne doit pas faire disparaître le chiffre facturé
  // d'Anthropic sous prétexte que Codex a tourné le même jour.
  const t = midnight() + 3600000;
  const events = [
    local(t, 1000, { source: 'codex-cli', model: 'gpt-5' }),
    billed(midnight(), 900, { source: 'openai-api', model: 'gpt-5' }),
    billed(midnight(), 4000),
  ];
  const rep = report(events, { from: midnight(-2), to: Date.now() });
  assert.equal(rep.totals.tokens.total, 5000, 'openai départagé, anthropic conservé');
});

test('provenance : l’export applique le même départage que l’affichage', () => {
  const t = midnight() + 10 * 3600000;
  const rows = exportRows([local(t, 1000), billed(midnight(), 1600)], { from: midnight() - DAY, to: Date.now() });
  const body = rows.slice(1);
  assert.equal(body.length, 1, 'une seule ligne : le doublon facturé est écarté');
  assert.equal(Number(body[0][10]), 1000);
});

// ---------------------------------------------------------------------------
// Réconciliation
// ---------------------------------------------------------------------------

test('réconciliation : l’écart local/facturé est chiffré, pas moyenné', () => {
  const t = midnight() + 10 * 3600000;
  const events = [local(t, 1000), billed(midnight(), 1500)];

  const rep = report(events, { from: midnight() - DAY, to: Date.now() });
  const anthropic = rep.reconciliation.find((r) => r.family === 'anthropic');
  assert.ok(anthropic, 'la famille comparable est présente');
  assert.equal(anthropic.local, 1000);
  assert.equal(anthropic.billed, 1500);
  assert.equal(Math.round(anthropic.deltaPct), 50, '+50 % côté facturé : une autre machine, ou une lecture fautive');
});

test('réconciliation : un jour sans chiffre facturé n’est pas un écart de 100 %', () => {
  const events = [local(midnight() + 3600000, 1000)];
  const rep = report(events, { from: midnight(-2), to: Date.now() });
  assert.equal(rep.reconciliation.length, 0, 'rien à comparer, donc rien à annoncer');
});

// ---------------------------------------------------------------------------
// Jauges
// ---------------------------------------------------------------------------

test('jauges : un agrégat journalier ne se déverse pas dans une fenêtre de 5 h', () => {
  // Horodaté à minuit, il tombait dans la fenêtre glissante et y injectait la
  // consommation d'une journée entière — toutes machines de l'organisation
  // confondues.
  const now = midnight() + 2 * 3600000; // 2 h du matin : minuit est dans la fenêtre de 5 h
  const events = [local(now - 600000, 1000), billed(midnight(), 9_000_000)];

  const gauges = computeGauges(events, [], { limits: { five_hour: 100000 } }, now);
  const five = gauges.find((g) => g.id === 'anthropic-five_hour');
  assert.ok(five, 'la fenêtre 5 h existe');
  assert.equal(five.tokens.total, 1000, 'seule la consommation mesurée localement compte');
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

test('projection : le rythme récent donne l’heure de saturation', () => {
  const { projectSaturation, PACE_WINDOW_MS } = require('../src/core/ratelimits');
  const now = Date.now();
  // 1 000 tokens d'entrée par minute sur la fenêtre d'observation.
  const events = [];
  for (let i = 1; i <= 45; i++) events.push(local(now - i * 60000, 1000));

  // Plafond 100 000 pondérés, moitié consommée : il reste 50 000, à 1 000/min.
  const gauge = { percent: 50, limit: 100000, used: 50000, provider: 'anthropic', resetsAt: now + 5 * 3600000 };
  const p = projectSaturation(gauge, events, now);

  assert.ok(p, 'une projection est produite');
  assert.equal(Math.round(p.inMs / 60000), 50, 'cinquante minutes de marge');
  assert.equal(p.beforeReset, true);
  assert.equal(Math.round(p.ratePerHour), Math.round((45000 / PACE_WINDOW_MS) * 3600000));
});

test('projection : sans activité récente, aucune projection', () => {
  const { projectSaturation } = require('../src/core/ratelimits');
  const now = Date.now();
  const events = [local(now - 5 * 3600000, 50000)];
  const gauge = { percent: 50, limit: 100000, used: 50000, provider: 'anthropic', resetsAt: now + 3600000 };
  assert.equal(projectSaturation(gauge, events, now), null, 'une cadence nulle ne sature jamais');
});

test('projection : une saturation postérieure à la réinitialisation est signalée comme telle', () => {
  const { projectSaturation } = require('../src/core/ratelimits');
  const now = Date.now();
  const events = [];
  for (let i = 1; i <= 45; i++) events.push(local(now - i * 60000, 100));

  const gauge = { percent: 10, limit: 1e7, used: 1e6, provider: 'anthropic', resetsAt: now + 600000 };
  const p = projectSaturation(gauge, events, now);
  assert.ok(p);
  assert.equal(p.beforeReset, false, 'la fenêtre se vide avant qu’on la remplisse');
});

const MIN = 60000;

/** Cadence constante sur toute la fenêtre d'observation, en tokens par minute. */
function pace(now, perMinute) {
  const events = [];
  for (let i = 1; i <= 45; i++) events.push(local(now - i * MIN, perMinute));
  return events;
}

test('projection : l’hebdomadaire tient compte des pauses imposées par la limite 5 h', () => {
  const { projectSaturation } = require('../src/core/ratelimits');
  const now = Date.now();
  const events = pace(now, 1000);

  // La 5 h se réinitialise dans une heure ; il lui reste 50 min de marge, donc
  // 10 min de temps mort avant de pouvoir reprendre. Ensuite, chaque fenêtre
  // rend 100 000 tokens qu'on brûle en 100 min, pour 300 min d'attente.
  const five = { provider: 'anthropic', windowHours: 5, percent: 50, limit: 100000, used: 50000, resetsAt: now + 60 * MIN };
  const week = { provider: 'anthropic', windowHours: 168, percent: 0, limit: 500000, used: 0, resetsAt: now + 168 * 3600000 };

  const p = projectSaturation(week, events, now, [five, week]);
  assert.ok(p, 'une projection est produite');
  assert.equal(p.throttled, true, 'la limite courte s’interpose');
  assert.equal(Math.round(p.inMs / MIN), 1310, '21 h 50, et non les 8 h 20 d’une extrapolation libre');
  assert.equal(p.beforeReset, true);
});

test('projection : un rythme que la fenêtre 5 h absorbe ne fait perdre aucune minute', () => {
  const { projectSaturation } = require('../src/core/ratelimits');
  const now = Date.now();
  // 100 tokens/min, très en dessous des 100 000 par tranche de cinq heures.
  const events = pace(now, 100);

  const five = { provider: 'anthropic', windowHours: 5, percent: 0, limit: 100000, used: 0, resetsAt: now + 60 * MIN };
  const week = { provider: 'anthropic', windowHours: 168, percent: 0, limit: 60000, used: 0, resetsAt: now + 168 * 3600000 };

  const p = projectSaturation(week, events, now, [five, week]);
  assert.ok(p);
  assert.equal(p.throttled, false, 'aucune pause à insérer');
  assert.equal(Math.round(p.inMs / MIN), 600, 'le résultat retombe sur la projection simple');
});

test('projection : une saturation hors d’atteinte n’est pas annoncée', () => {
  const { projectSaturation } = require('../src/core/ratelimits');
  const now = Date.now();
  const events = pace(now, 1000);

  // À 1 000 tokens par tranche de cinq heures, la semaine ne sera jamais pleine.
  const five = { provider: 'anthropic', windowHours: 5, percent: 0, limit: 1000, used: 0, resetsAt: now + 60 * MIN };
  const week = { provider: 'anthropic', windowHours: 168, percent: 0, limit: 1e9, used: 0, resetsAt: now + 168 * 3600000 };

  assert.equal(projectSaturation(week, events, now, [five, week]), null);
});

test('projection : sans fenêtre 5 h exploitable, on ne bride pas au jugé', () => {
  const { projectSaturation } = require('../src/core/ratelimits');
  const now = Date.now();
  const events = pace(now, 1000);
  const week = { provider: 'anthropic', windowHours: 168, percent: 0, limit: 500000, used: 0, resetsAt: now + 168 * 3600000 };

  // Fenêtre courte glissante : on ignore quand le budget revient.
  const rolling = { provider: 'anthropic', windowHours: 5, percent: 50, limit: 100000, used: 50000, resetsAt: null };
  const p = projectSaturation(week, events, now, [rolling, week]);
  assert.ok(p);
  assert.equal(p.throttled, false);
  assert.equal(Math.round(p.inMs / MIN), 500, 'la projection simple, faute de mieux');
});

test('projection : la fenêtre 5 h elle-même n’est bridée par rien', () => {
  const { projectSaturation } = require('../src/core/ratelimits');
  const now = Date.now();
  const events = pace(now, 1000);
  const five = { provider: 'anthropic', windowHours: 5, percent: 50, limit: 100000, used: 50000, resetsAt: now + 4 * 3600000 };

  const p = projectSaturation(five, events, now, [five]);
  assert.ok(p);
  assert.equal(p.throttled, false);
  assert.equal(Math.round(p.inMs / MIN), 50, 'c’est elle le verrou : rien ne s’interpose');
});

test('projection : sans échelle fiable, rien n’est extrapolé', () => {
  const { projectSaturation } = require('../src/core/ratelimits');
  const now = Date.now();
  const events = [local(now - 60000, 1000)];
  assert.equal(projectSaturation({ percent: null, provider: 'anthropic' }, events, now), null);
  assert.equal(projectSaturation({ percent: 40, limit: null, used: 0, provider: 'anthropic' }, events, now), null);
  assert.equal(projectSaturation({ percent: 100, limit: 1000, used: 1000, provider: 'anthropic' }, events, now), null);
});

test('alertes : la trajectoire prévient avant le premier seuil, une seule fois', () => {
  const alerts = require('../src/core/alerts');
  const now = Date.now();
  const gauge = {
    id: 'anthropic-five_hour', product: 'Claude', label: 'Session 5 h', limitSource: 'live',
    percent: 35, resetsAt: now + 4 * 3600000,
    projection: { at: now + 90 * 60000, inMs: 90 * 60000, ratePerHour: 1, beforeReset: true },
  };
  const config = { alerts: { enabled: true, thresholds: [80, 95] } };

  const first = alerts.evaluate([gauge], config, {}, now);
  assert.equal(first.notifications.length, 1);
  assert.equal(first.notifications[0].threshold, alerts.TRAJECTORY);

  const second = alerts.evaluate([gauge], config, first.state, now);
  assert.equal(second.notifications.length, 0, 'une trajectoire ne se répète pas dans la même fenêtre');
});

test('alertes : passé le premier seuil, la trajectoire se tait et laisse parler le seuil', () => {
  const alerts = require('../src/core/alerts');
  const now = Date.now();
  const gauge = {
    id: 'anthropic-five_hour', product: 'Claude', label: 'Session 5 h', limitSource: 'live',
    percent: 84, resetsAt: now + 3600000,
    projection: { at: now + 600000, inMs: 600000, ratePerHour: 1, beforeReset: true },
  };
  const res = alerts.evaluate([gauge], { alerts: { enabled: true, thresholds: [80, 95] } }, {}, now);
  assert.deepEqual(res.notifications.map((n) => n.threshold), [80], 'un seul message, celui du seuil franchi');
});

test('alertes : une saturation après réinitialisation ne déclenche rien', () => {
  const alerts = require('../src/core/alerts');
  const now = Date.now();
  const gauge = {
    id: 'anthropic-five_hour', product: 'Claude', label: 'Session 5 h', limitSource: 'live',
    percent: 20, resetsAt: now + 600000,
    projection: { at: now + 3600000, inMs: 3600000, ratePerHour: 1, beforeReset: false },
  };
  assert.equal(alerts.evaluate([gauge], { alerts: { enabled: true } }, {}, now).notifications.length, 0);
});
