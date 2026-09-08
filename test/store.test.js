'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/core/store');
const { hourHistogram, dailySeries, report } = require('../src/core/aggregate');

const DAY = 86400000;
const HOUR = 3600000;

/** Isole chaque test dans son propre TRACE_HOME. */
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-'));
  const previous = process.env.TRACE_HOME;
  process.env.TRACE_HOME = dir;
  store.resetSignature();
  t.after(() => {
    if (previous == null) delete process.env.TRACE_HOME;
    else process.env.TRACE_HOME = previous;
    store.resetSignature();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function event(ts, total, over = {}) {
  return {
    ts,
    source: 'claude-code',
    model: 'claude-sonnet-4-5',
    project: 'trace',
    session: `s-${ts}`,
    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, total },
    requests: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

test('compaction : le détail ancien est replié, le récent est intact', () => {
  const now = Date.now();
  // Ancré en début d'heure : sans cela, un test lancé à 22 h 59 voyait ses
  // trois requêtes tomber dans deux heures différentes, et échouait une fois
  // par heure.
  const old = new Date(now - 120 * DAY);
  old.setMinutes(0, 0, 0);
  const events = [
    event(old.getTime(), 100),
    event(old.getTime() + 60000, 200),
    event(old.getTime() + 120000, 300),
    event(now - HOUR, 50),
  ];

  const res = store.compact(events, { olderThanDays: 90, now });
  assert.equal(res.events.length, 2, 'trois requêtes de la même heure valent une ligne');
  const bucket = res.events.find((e) => e.compacted === 'hour');
  assert.equal(bucket.tokens.total, 600);
  assert.equal(bucket.requests, 3, 'le compte de requêtes survit au repli');
  assert.equal(bucket.session, null, 'la session n’est pas inventée');
  assert.equal(res.events.find((e) => !e.compacted).tokens.total, 50, 'le récent n’est pas touché');
});

test('compaction : elle ne déplace pas un seul token', () => {
  const now = Date.now();
  const events = [];
  // Dix heures anciennes, vingt requêtes chacune, réparties sur six
  // combinaisons modèle × projet.
  for (let i = 0; i < 200; i++) {
    const ts = now - 100 * DAY + Math.floor(i / 20) * HOUR + (i % 20) * 60000;
    events.push(event(ts, 10 + i, { project: i % 3 ? 'a' : 'b', model: i % 2 ? 'claude-opus-4-5' : 'claude-sonnet-4-5' }));
  }
  const before = events.reduce((s, e) => s + e.tokens.total, 0);
  const res = store.compact(events, { olderThanDays: 30, now });

  assert.ok(res.events.length < events.length, 'le volume a bien diminué');
  assert.equal(res.events.reduce((s, e) => s + e.tokens.total, 0), before);
  assert.equal(res.events.reduce((s, e) => s + e.requests, 0), 200);
});

test('compaction : l’histogramme horaire reste exact — c’est la raison du grain à l’heure', () => {
  const now = Date.now();
  const events = [];
  // Trois heures distinctes d'une même journée ancienne.
  const base = new Date(now - 150 * DAY);
  base.setHours(9, 0, 0, 0);
  for (const [h, n] of [[0, 3], [4, 5], [11, 2]]) {
    for (let i = 0; i < n; i++) events.push(event(base.getTime() + h * HOUR + i * 60000, 100));
  }

  const opts = { from: now - 200 * DAY, to: now };
  const avant = hourHistogram(events, opts);
  const apres = hourHistogram(store.compact(events, { olderThanDays: 90, now }).events, opts);
  assert.deepEqual(apres.map((x) => x.tokens), avant.map((x) => x.tokens));

  const jAvant = dailySeries(events, now - 200 * DAY, now, opts).filter((d) => d.tokens.total);
  const jApres = dailySeries(store.compact(events, { olderThanDays: 90, now }).events, now - 200 * DAY, now, opts).filter((d) => d.tokens.total);
  assert.deepEqual(jApres.map((d) => [d.date, d.tokens.total]), jAvant.map((d) => [d.date, d.tokens.total]));
});

test('compaction : les modèles et projets ne sont pas mélangés', () => {
  const now = Date.now();
  const t = now - 200 * DAY;
  const events = [
    event(t, 100, { model: 'claude-opus-4-5', project: 'a' }),
    event(t + 60000, 200, { model: 'claude-sonnet-4-5', project: 'a' }),
    event(t + 120000, 300, { model: 'claude-opus-4-5', project: 'b' }),
  ];
  const res = store.compact(events, { olderThanDays: 90, now });
  assert.equal(res.events.length, 3, 'trois combinaisons distinctes restent trois lignes');

  const rep = report(res.events, { from: now - 300 * DAY, to: now });
  assert.equal(rep.byModel.find((m) => m.key === 'claude-opus-4-5').tokens.total, 400);
  assert.equal(rep.byProject.find((p) => p.key === 'b').tokens.total, 300);
});

test('compaction : désactivée, elle ne fait rien', () => {
  const events = [event(Date.now() - 500 * DAY, 100)];
  for (const off of [0, null, undefined]) {
    assert.equal(store.compact(events, { olderThanDays: off }).events.length, 1);
  }
});

test('compaction : un agrégat déjà replié n’est pas replié une seconde fois', () => {
  const now = Date.now();
  const already = { ...event(now - 300 * DAY, 500), compacted: 'day', session: null };
  const res = store.compact([already], { olderThanDays: 90, now });
  assert.equal(res.events[0].compacted, 'day', 'un repli journalier reste journalier');
  assert.equal(res.events[0].tokens.total, 500);
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test('permissions : dossier en 0700, index et configuration en 0600', { skip: process.platform === 'win32' }, (t) => {
  const dir = sandbox(t);
  store.saveConfig({ ...store.DEFAULT_CONFIG });
  store.saveIndex({ version: 2, collectors: {}, events: [event(Date.now(), 10)], quota: [] }, store.DEFAULT_CONFIG);

  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(dir), 0o700, 'le dossier ne doit pas être lisible par les autres comptes');
  assert.equal(mode(store.configPath()), 0o600);
  assert.equal(mode(store.indexPath()), 0o600, 'l’index porte les noms de projets et les sessions');
});

// ---------------------------------------------------------------------------
// Propriété de l'index
// ---------------------------------------------------------------------------

// Un processus assurément vivant, et assurément différent du nôtre.
//
// Les marques d'un « autre processus » se faisaient avec le PID 1. C'est vrai
// sous Unix, où init ne meurt jamais ; Windows n'a pas d'init, `kill(1, 0)` y
// lève ESRCH, et l'index du propriétaire se faisait écraser sous les yeux du
// test. Le parent — npm, ou le lanceur de tests — est vivant partout.
const ALIVE_PID = process.ppid;

test('propriété : notre propre marque ne nous bloque pas', (t) => {
  sandbox(t);
  store.claimOwnership();
  assert.equal(store.ownedByAnother(), false);
});

test('propriété : une marque fraîche d’un processus vivant nous met en lecture seule', (t) => {
  sandbox(t);
  // Selon les droits, `kill(pid, 0)` réussit ou renvoie EPERM — les deux
  // prouvent que le processus est là.
  fs.writeFileSync(store.ownerPath(), JSON.stringify({ pid: ALIVE_PID, at: Date.now() }));
  assert.equal(store.ownedByAnother(), true);
});

test('propriété : une marque périmée ne condamne pas l’index', (t) => {
  sandbox(t);
  fs.writeFileSync(store.ownerPath(), JSON.stringify({ pid: ALIVE_PID, at: Date.now() - store.OWNER_STALE_MS - 1000 }));
  assert.equal(store.ownedByAnother(), false);
});

test('propriété : un processus mort ne condamne pas l’index', (t) => {
  sandbox(t);
  // Un PID hors de portée du système : introuvable, donc sans propriétaire.
  fs.writeFileSync(store.ownerPath(), JSON.stringify({ pid: 0x7ffffffe, at: Date.now() }));
  assert.equal(store.ownedByAnother(), false);
});

test('propriété : un second processus n’écrase pas l’index du premier', (t) => {
  sandbox(t);
  const first = { version: 2, collectors: { a: 1 }, events: [event(Date.now(), 10)], quota: [] };
  store.saveIndex(first, store.DEFAULT_CONFIG);
  const written = fs.readFileSync(store.indexPath(), 'utf8');

  // Un autre processus tient désormais la marque.
  fs.writeFileSync(store.ownerPath(), JSON.stringify({ pid: ALIVE_PID, at: Date.now() }));
  store.resetSignature();
  const result = store.saveIndex({ version: 2, collectors: {}, events: [], quota: [] }, store.DEFAULT_CONFIG);

  assert.equal(fs.readFileSync(store.indexPath(), 'utf8'), written, 'le fichier du propriétaire est intact');
  assert.ok(result, 'l’appelant reçoit tout de même son index élagué, en mémoire');
});

test('propriété : `readOnly` suffit à empêcher toute écriture', (t) => {
  sandbox(t);
  store.saveIndex({ version: 2, collectors: {}, events: [], quota: [] }, { ...store.DEFAULT_CONFIG, readOnly: true });
  assert.equal(fs.existsSync(store.indexPath()), false);
});

// ---------------------------------------------------------------------------
// Frontière de compaction
// ---------------------------------------------------------------------------

test('compaction : une relecture complète ne ressuscite pas le détail replié', async (t) => {
  sandbox(t);
  const core = require('../src/core');
  const collectors = require('../src/core/collectors');
  const original = collectors.ALL.slice();
  t.after(() => {
    collectors.ALL.length = 0;
    collectors.ALL.push(...original);
  });

  const now = Date.now();
  // Même précaution qu'au-dessus : ancré en début d'heure, pour que les deux
  // requêtes tombent bien dans le même agrégat quelle que soit l'heure du test.
  const vieux0 = new Date(now - 200 * DAY);
  vieux0.setMinutes(0, 0, 0);
  const vieux = [event(vieux0.getTime(), 100), event(vieux0.getTime() + 60000, 200)];
  // Le collecteur renvoie inlassablement les mêmes vieilles requêtes, comme
  // après une remise à zéro des offsets.
  collectors.ALL.length = 0;
  collectors.ALL.push({ id: 'claude-code', label: 'Claude Code', isAvailable: () => true, collect: () => ({ events: vieux, quota: [], state: {}, stats: {} }) });

  const config = { ...store.DEFAULT_CONFIG, compactAfterDays: 90 };
  let state = await core.refresh({ config, index: { version: 2, collectors: {}, events: [], quota: [] } });
  assert.equal(state.events.length, 1, 'les deux requêtes sont repliées en une');
  assert.equal(state.events[0].tokens.total, 300);

  state = await core.refresh({ config, index: state.index });
  assert.equal(state.events.length, 1, 'la seconde lecture ne rajoute rien');
  assert.equal(state.events[0].tokens.total, 300, 'et surtout ne double pas le total');
});
