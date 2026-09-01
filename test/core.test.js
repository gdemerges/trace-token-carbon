'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveModel, CACHE_MULTIPLIERS } = require('../src/core/models');
const { cost, costWithoutCache } = require('../src/core/pricing');
const carbon = require('../src/core/carbon');
const { computeGauges, weightedUsage, applyUserCalibration, durationLabel, LIVE_FRESH_MS } = require('../src/core/ratelimits');
const { report, exportRows, toCsv } = require('../src/core/aggregate');
const store = require('../src/core/store');
const claudeCode = require('../src/core/collectors/claude-code');
const codex = require('../src/core/collectors/codex-cli');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));

// ---------------------------------------------------------------------------
test('registre : résolution des identifiants datés vers le modèle canonique', () => {
  assert.equal(resolveModel('claude-sonnet-4-5-20250929').id, 'claude-sonnet-4-5');
  assert.equal(resolveModel('claude-opus-4-5-20251101').id, 'claude-opus-4-5');
  assert.equal(resolveModel('claude-opus-5').pricing.output, 25);
  assert.equal(resolveModel('claude-sonnet-5').pricing.input, 2);
});

test('registre : un modèle inconnu reste visible plutôt que disparaître', () => {
  const m = resolveModel('un-modele-jamais-vu');
  assert.equal(m.params.confidence, 'unknown');
  assert.equal(m.pricing, null, 'un tarif inconnu doit rester null, pas devenir 0');
});

test('registre : la taille d’un modèle local est lue dans son nom', () => {
  const m = resolveModel('llama3.1:70b');
  assert.equal(m.provider, 'local');
  assert.equal(m.params.active.min, 70);
  assert.equal(m.params.confidence, 'disclosed');
});

// ---------------------------------------------------------------------------
test('tarification : les multiplicateurs de cache sont appliqués par TTL', () => {
  const model = resolveModel('claude-opus-5'); // 5 $ / 25 $ par million
  const c = cost({ input: 1e6, output: 0, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }, model);
  const expected = 5 + 5 * CACHE_MULTIPLIERS.read + 5 * CACHE_MULTIPLIERS.write5m + 5 * CACHE_MULTIPLIERS.write1h;
  assert.ok(Math.abs(c - expected) < 1e-9, `${c} != ${expected}`);
});

test('tarification : un coût inconnu vaut null, un modèle local vaut 0', () => {
  assert.equal(cost({ input: 1e6 }, resolveModel('modele-inconnu')), null);
  assert.equal(cost({ input: 1e6 }, resolveModel('llama3.1:70b')), 0);
});

test('tarification : le cache fait bien économiser', () => {
  const model = resolveModel('claude-opus-5');
  const tokens = { input: 1000, output: 500, cacheRead: 1e6, cacheWrite5m: 1e5 };
  assert.ok(costWithoutCache(tokens, model) > cost(tokens, model));
});

// ---------------------------------------------------------------------------
test('carbone : la fourchette est ordonnée et le médian est dedans', () => {
  const e = carbon.estimate({ input: 5000, output: 800 }, resolveModel('claude-opus-5'));
  assert.ok(e.gramsCO2e.min < e.gramsCO2e.max);
  assert.ok(e.gramsCO2e.mid >= e.gramsCO2e.min && e.gramsCO2e.mid <= e.gramsCO2e.max);
});

test('carbone : aucun token consommé, aucune empreinte', () => {
  const e = carbon.estimate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, resolveModel('claude-opus-5'));
  assert.equal(e.gramsCO2e.max, 0);
  assert.equal(e.energyWh.max, 0);
});

test('carbone : croissance monotone avec le volume', () => {
  const m = resolveModel('claude-sonnet-5');
  const a = carbon.estimate({ output: 1000 }, m).gramsCO2e.mid;
  const b = carbon.estimate({ output: 2000 }, m).gramsCO2e.mid;
  assert.ok(b > a * 1.9 && b < a * 2.1, 'doit être quasi linéaire dans le volume');
});

test('carbone : un token généré coûte bien plus qu’un token lu en cache', () => {
  const m = resolveModel('claude-opus-5');
  const out = carbon.estimate({ output: 10000 }, m).gramsCO2e.mid;
  const cached = carbon.estimate({ cacheRead: 10000 }, m).gramsCO2e.mid;
  assert.ok(out > cached * 50, `sortie ${out} devrait dominer le cache lu ${cached}`);
});

test('carbone : régression — l’énergie GPU ne doit PAS être multipliée par le nombre de GPU', () => {
  // La corrélation EcoLogits rend déjà l'énergie de l'ensemble des GPU.
  // Contrôle physique : à 70 Md de paramètres actifs, ~7,7 mWh par token généré.
  // Un facteur gpuCount parasite ferait exploser ce chiffre.
  const m = {
    provider: 'anthropic',
    params: { total: { min: 140, max: 140 }, active: { min: 70, max: 70 }, confidence: 'estimated' },
  };
  const e = carbon.estimate({ output: 1000 }, m, { pue: 1 });
  const perToken = e.energyWh.mid / 1000;
  assert.ok(perToken > 0.006 && perToken < 0.012, `${perToken} Wh/token hors de l'ordre de grandeur attendu`);
});

test('carbone : le mix électrique change le résultat proportionnellement', () => {
  const m = resolveModel('claude-opus-5');
  const fr = carbon.estimate({ output: 5000 }, m, { gridKey: 'france' });
  const world = carbon.estimate({ output: 5000 }, m, { gridKey: 'world' });
  assert.ok(world.gramsCO2e.mid > fr.gramsCO2e.mid);
  assert.equal(fr.gridIntensity, 56);
});

test('carbone : les sommes s’additionnent borne à borne', () => {
  const m = resolveModel('claude-opus-5');
  const a = carbon.estimate({ output: 1000 }, m);
  const b = carbon.estimate({ output: 2000 }, m);
  const s = carbon.sum([a, b]);
  assert.ok(Math.abs(s.gramsCO2e.min - (a.gramsCO2e.min + b.gramsCO2e.min)) < 1e-9);
});

// ---------------------------------------------------------------------------
test('collecteur Claude Code : les réécritures de streaming ne sont comptées qu’une fois', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'session.jsonl');
  const line = (id, out) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-01T10:00:00.000Z',
      cwd: '/tmp/projet',
      sessionId: 's1',
      requestId: 'req_1',
      message: { id, role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } } },
    });
  // Même message.id écrit trois fois, comme le fait réellement Claude Code.
  fs.writeFileSync(file, [line('msg_A', 50), line('msg_A', 50), line('msg_A', 50), line('msg_B', 70)].join('\n') + '\n');

  const r = claudeCode.collect({ claudeCodeDir: dir }, {});
  assert.equal(r.events.length, 2, 'deux messages distincts attendus');
  assert.equal(r.stats.skippedDuplicates, 2);
  assert.equal(r.events[0].project, 'projet');
  assert.equal(r.events[0].tokens.cacheWrite5m, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collecteur Claude Code : la lecture incrémentale ne recompte pas l’existant', () => {
  const dir = tmpdir();
  const file = path.join(dir, 's.jsonl');
  const mk = (id) =>
    JSON.stringify({
      type: 'assistant', timestamp: '2026-08-01T10:00:00.000Z', cwd: '/tmp/p', sessionId: 's',
      message: { id, role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
    }) + '\n';

  fs.writeFileSync(file, mk('a') + mk('b'));
  const first = claudeCode.collect({ claudeCodeDir: dir }, {});
  assert.equal(first.events.length, 2);

  fs.appendFileSync(file, mk('c'));
  const second = claudeCode.collect({ claudeCodeDir: dir }, first.state);
  assert.equal(second.events.length, 1, 'seule la ligne ajoutée doit remonter');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collecteur Claude Code : une dernière ligne incomplète est ignorée puis reprise', () => {
  const dir = tmpdir();
  const file = path.join(dir, 's.jsonl');
  const rec = (id) =>
    JSON.stringify({
      type: 'assistant', timestamp: '2026-08-01T10:00:00.000Z', sessionId: 's',
      message: { id, role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
    });

  // Claude Code écrit pendant qu'on lit : la dernière ligne est tronquée.
  fs.writeFileSync(file, rec('a') + '\n' + rec('b').slice(0, 40));
  const first = claudeCode.collect({ claudeCodeDir: dir }, {});
  assert.equal(first.events.length, 1, 'la ligne tronquée ne doit pas être comptée');

  // Le processus finit sa ligne : elle doit être reprise, exactement une fois.
  fs.writeFileSync(file, rec('a') + '\n' + rec('b') + '\n');
  const second = claudeCode.collect({ claudeCodeDir: dir }, first.state);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].tokens.total, 2);

  // Et un troisième passage sans changement ne doit plus rien remonter.
  const third = claudeCode.collect({ claudeCodeDir: dir }, second.state);
  assert.equal(third.events.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collecteur Claude Code : les quotaLimits sont extraits', () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, 's.jsonl'),
    JSON.stringify({
      type: 'assistant', timestamp: '2026-08-31T19:55:49.913Z', sessionId: 's', error: 'rate_limit',
      quotaLimits: { status: 'rejected', resetsAt: 1788220800, rateLimitType: 'five_hour', isUsingOverage: false },
      message: { id: 'z', role: 'assistant', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
    }) + '\n'
  );
  const r = claudeCode.collect({ claudeCodeDir: dir }, {});
  assert.equal(r.quota.length, 1);
  assert.equal(r.quota[0].type, 'five_hour');
  assert.equal(r.quota[0].resetsAt, 1788220800000, 'les secondes epoch doivent être converties en ms');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collecteur Codex : on somme les deltas par tour, pas le cumul de session', () => {
  const dir = tmpdir();
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const tc = (total, last) =>
    JSON.stringify({
      timestamp: '2026-08-15T14:45:22.598Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: total, output_tokens: 0, cached_input_tokens: 0, total_tokens: total },
          last_token_usage: { input_tokens: last, output_tokens: 0, cached_input_tokens: 0, total_tokens: last },
        },
      },
    }) + '\n';
  // Trois tours de 100 : le cumul monte à 300, mais la consommation vaut 300 et non 600.
  fs.writeFileSync(path.join(sessions, 'rollout-x.jsonl'), tc(100, 100) + tc(200, 100) + tc(300, 100));

  const r = codex.collect({ codexDir: dir }, {});
  const total = r.events.reduce((s, e) => s + e.tokens.total, 0);
  assert.equal(total, 300, 'utiliser total_token_usage donnerait 600');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
const ev = (ts, model, tokens, extra = {}) => ({
  ts, source: 'claude-code', model, project: 'p', session: 's', requests: 1,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, total: 0, ...tokens, },
  ...extra,
});
const withTotal = (t) => ({ ...t, total: (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) });

test('agrégation : le coût est calculé par modèle puis sommé, jamais sur un tarif moyen', () => {
  const now = Date.now();
  const events = [
    ev(now - 1000, 'claude-opus-5', withTotal({ input: 1e6 })),   // 5 $
    ev(now - 900, 'claude-sonnet-5', withTotal({ input: 1e6 })),  // 2 $
  ];
  const rep = report(events, { from: now - 86400000, to: now });
  assert.ok(Math.abs(rep.totals.costUSD - 7) < 1e-9, `attendu 7 $, obtenu ${rep.totals.costUSD}`);
  assert.equal(rep.byModel.length, 2);
});

test('agrégation : la série journalière est continue, trous compris', () => {
  const now = Date.now();
  const rep = report([ev(now - 5 * 86400000, 'claude-opus-5', withTotal({ output: 100 }))], {
    from: now - 7 * 86400000, to: now,
  });
  assert.equal(rep.daily.length, 8);
  assert.ok(rep.daily.every((d) => typeof d.tokens.total === 'number'));
  assert.equal(rep.daily.filter((d) => d.tokens.total > 0).length, 1);
});

test('agrégation : l’économie de cache est positive et cohérente', () => {
  const now = Date.now();
  const rep = report([ev(now - 1000, 'claude-opus-5', withTotal({ cacheRead: 1e7, input: 1000, output: 500 }))], {
    from: now - 86400000, to: now,
  });
  assert.ok(rep.totals.cacheSavingsUSD > 0);
  assert.ok(rep.totals.cacheHitRatio > 0.9);
});

// ---------------------------------------------------------------------------
test('limites : la fenêtre glissante regarde en arrière, pas en avant', () => {
  const now = Date.now();
  // Un événement il y a deux heures DOIT tomber dans la fenêtre de 5 heures.
  const events = [ev(now - 2 * 3600 * 1000, 'claude-opus-5', withTotal({ output: 1000 }))];
  const g = computeGauges(events, [], {}, now).find((x) => x.id === 'anthropic-five_hour');
  assert.ok(g.used > 0, 'la fenêtre glissante doit couvrir les 5 dernières heures');
  assert.equal(g.rolling, true);
  assert.ok(g.startsAt < now && g.startsAt >= now - 5 * 3600 * 1000);
});

test('limites : un refus 429 est mesuré mais ne devient pas une échelle', () => {
  const now = Date.now();
  const resetsAt = now - 3600 * 1000;
  const rejectionTs = resetsAt - 60 * 1000;
  const events = [
    ev(resetsAt - 4 * 3600 * 1000, 'claude-opus-5', withTotal({ output: 200000 })),
    ev(now - 60 * 1000, 'claude-opus-5', withTotal({ output: 1000 })),
  ];
  const quota = [{ source: 'claude-code', ts: rejectionTs, type: 'five_hour', status: 'rejected', resetsAt, cause: 'window' }];
  const g = computeGauges(events, quota, {}, now).find((x) => x.id === 'anthropic-five_hour');

  // La mesure est faite et reste consultable...
  assert.ok(g.calibration && g.calibration.limit > 0);
  // ...mais elle ne pilote aucun pourcentage : elle s'est révélée fausse d'un
  // facteur 2,6 face au chiffre réel du serveur.
  assert.equal(g.percent, null);
  assert.ok(g.used > 0, 'la consommation de la fenêtre reste affichable');
});

test('limites : un plafond renseigné par l’utilisateur prime sur le calibrage', () => {
  const now = Date.now();
  const events = [ev(now - 1000, 'claude-opus-5', withTotal({ output: 1000 }))];
  const quota = [{ source: 'claude-code', ts: now - 7200000, type: 'five_hour', status: 'rejected', resetsAt: now - 3600000 }];
  const g = computeGauges(events, quota, { limits: { five_hour: 1e6 } }, now).find((x) => x.id === 'anthropic-five_hour');
  assert.equal(g.limitSource, 'configured');
  assert.equal(g.limit, 1e6);
});

test('limites : la pondération reflète le coût réel des classes de tokens', () => {
  assert.ok(weightedUsage({ output: 100 }) > weightedUsage({ cacheRead: 100 }));
  assert.ok(weightedUsage({ input: 100 }) > weightedUsage({ cacheRead: 100 }));
});

// ---------------------------------------------------------------------------
test('limites : un refus pour plafond de dépense ne calibre pas la fenêtre', () => {
  const now = Date.now();
  const resetsAt = now - 3600 * 1000;
  const events = [
    ev(resetsAt - 4 * 3600 * 1000, 'claude-opus-5', withTotal({ output: 500000 })),
    ev(now - 60 * 1000, 'claude-opus-5', withTotal({ output: 1000 })),
  ];
  // Seul refus enregistré : un plafond de dépense mensuel. Il ne dit rien de
  // l'occupation de la fenêtre 5 h et ne doit donc produire aucune échelle.
  const quota = [{ source: 'claude-code', ts: resetsAt - 60000, type: 'five_hour', status: 'rejected', resetsAt, cause: 'spend' }];
  const g = computeGauges(events, quota, {}, now).find((x) => x.id === 'anthropic-five_hour');
  assert.equal(g.limit, null);
  assert.equal(g.percent, null, 'mieux vaut aucune échelle qu’une échelle fausse');
});

test('limites : un refus de session ne pilote plus aucun pourcentage affiché', () => {
  const now = Date.now();
  const resetsAt = now - 3600 * 1000;
  const events = [
    ev(resetsAt - 4 * 3600 * 1000, 'claude-opus-5', withTotal({ output: 500000 })),
    ev(now - 60 * 1000, 'claude-opus-5', withTotal({ output: 1000 })),
  ];
  const quota = [{ source: 'claude-code', ts: resetsAt - 60000, type: 'five_hour', status: 'rejected', resetsAt, cause: 'window' }];
  const g = computeGauges(events, quota, {}, now).find((x) => x.id === 'anthropic-five_hour');
  // Mesurée en conditions réelles, cette déduction s'écartait d'un facteur 2,6
  // (31 % annoncés pour 79 % réels). Sous-estimer l'occupation ferait croire à
  // une marge inexistante : on préfère ne rien afficher.
  assert.equal(g.percent, null);
  assert.equal(g.limitSource, null);
  assert.ok(g.calibration, 'le calcul reste exposé à titre indicatif');
});

test('limites : le relevé de l’utilisateur donne exactement le pourcentage saisi', () => {
  const now = Date.now();
  const events = [ev(now - 2 * 3600 * 1000, 'claude-opus-5', withTotal({ output: 100000 }))];
  const cfg = applyUserCalibration({}, events, [], 'anthropic-five_hour', 72, now);

  const g = computeGauges(events, [], cfg, now).find((x) => x.id === 'anthropic-five_hour');
  assert.ok(Math.abs(g.percent - 72) < 0.01, `attendu 72 %, obtenu ${g.percent}`);
  assert.equal(g.limitSource, 'user');
  assert.equal(g.approximate, false);
  assert.equal(cfg.limitMeta.five_hour.fromPercent, 72);
});

test('limites : le relevé de l’utilisateur prime sur le calibrage automatique', () => {
  const now = Date.now();
  const resetsAt = now - 3600 * 1000;
  const events = [
    ev(resetsAt - 4 * 3600 * 1000, 'claude-opus-5', withTotal({ output: 500000 })),
    ev(now - 60 * 1000, 'claude-opus-5', withTotal({ output: 50000 })),
  ];
  const quota = [{ source: 'claude-code', ts: resetsAt - 60000, type: 'five_hour', status: 'rejected', resetsAt, cause: 'window' }];
  const cfg = applyUserCalibration({}, events, quota, 'anthropic-five_hour', 40, now);
  const g = computeGauges(events, quota, cfg, now).find((x) => x.id === 'anthropic-five_hour');
  assert.equal(g.limitSource, 'user');
  assert.ok(Math.abs(g.percent - 40) < 0.01);
});

test('limites : calibrer sans consommation mesurée échoue explicitement', () => {
  const now = Date.now();
  assert.throws(() => applyUserCalibration({}, [], [], 'anthropic-five_hour', 50, now), /Aucune consommation/);
});

test('collecteur Claude Code : la cause réelle du refus est classée', () => {
  const dir = tmpdir();
  const mk = (text) =>
    JSON.stringify({
      type: 'assistant', timestamp: '2026-08-31T20:13:09.358Z', sessionId: 's', error: 'rate_limit',
      quotaLimits: { status: 'rejected', resetsAt: 1788220800, rateLimitType: 'five_hour' },
      message: { id: Math.random().toString(36), role: 'assistant', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text }] },
    }) + '\n';
  fs.writeFileSync(
    path.join(dir, 's.jsonl'),
    mk("You've hit your monthly spend limit · raise it at claude.ai") +
      mk("You've hit your session limit · resets 2am (Europe/Paris)")
  );
  const r = claudeCode.collect({ claudeCodeDir: dir }, {});
  // `rateLimitType` vaut « five_hour » dans les deux cas : seule la cause distingue.
  assert.deepEqual(r.quota.map((q) => q.cause), ['spend', 'window']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Usage en direct : l'endpoint n'est pas documenté publiquement, donc le
// parsing ne doit présumer d'aucune forme précise et ne jamais deviner.
const oauth = require('../src/core/collectors/anthropic-oauth');

test('usage direct : reconnaît une réponse à objets nommés', () => {
  const w = oauth.extractWindows({
    five_hour: { utilization: 79, resets_at: 1788220800 },
    seven_day: { utilization: 34, resets_at: 1788600000 },
  });
  const byType = {};
  for (const x of w) byType[oauth.normalizeWindow(x.key)] = x;
  assert.equal(byType.five_hour.percent, 79);
  assert.equal(byType.five_hour.resetsAt, 1788220800000, 'secondes epoch converties en ms');
  assert.equal(byType.weekly.percent, 34);
});

test('usage direct : reconnaît une réponse en tableau typé', () => {
  const w = oauth.extractWindows({
    limits: [
      { type: 'five_hour', used_percent: 79, resets_at: '2026-09-01T00:00:00Z' },
      { type: 'seven_day_opus', used_percent: 12, resets_at: '2026-09-05T00:00:00Z' },
    ],
  });
  assert.equal(w.length, 2);
  assert.equal(oauth.normalizeWindow(w[0].key), 'five_hour');
  assert.equal(oauth.normalizeWindow(w[1].key), 'weekly_opus');
  assert.equal(w[0].percent, 79);
});

test('usage direct : une fraction 0..1 est convertie en pourcentage', () => {
  const [w] = oauth.extractWindows({ five_hour: { utilization: 0.79, resets_at: 1788220800 } });
  assert.ok(Math.abs(w.percent - 79) < 0.001, `obtenu ${w.percent}`);
});

test('usage direct : une forme inconnue ne produit aucune fenêtre plutôt qu’un chiffre inventé', () => {
  const w = oauth.extractWindows({ message: 'ok', data: { totally: 'different' } });
  assert.equal(w.length, 0);
  assert.equal(oauth.normalizeWindow('quelque_chose'), null);
});

test('limites : le relevé en direct écrase le calibrage local', () => {
  const now = Date.now();
  const events = [ev(now - 2 * 3600 * 1000, 'claude-opus-5', withTotal({ output: 100000 }))];
  // Une calibration locale dirait 40 % ; le serveur dit 79 %. Le serveur gagne.
  const cfg = applyUserCalibration({}, events, [], 'anthropic-five_hour', 40, now);
  const quota = [{ source: 'anthropic-oauth', ts: now, type: 'five_hour', usedPercent: 79, resetsAt: now + 3600000, authoritative: true }];

  const g = computeGauges(events, quota, cfg, now).find((x) => x.id === 'anthropic-five_hour');
  assert.equal(g.percent, 79);
  assert.equal(g.limitSource, 'live');
  assert.equal(g.approximate, false);
  assert.equal(g.calibratable, false, 'inutile de proposer un calage quand le serveur répond');
});

test('limites : Codex dont la fenêtre a expiré repart à zéro, pas au chiffre périmé', () => {
  const now = Date.now();
  const expired = now - 30 * 86400000; // relevé vieux d'un mois
  const quota = [{
    source: 'codex-cli', ts: expired, type: '300min', windowMinutes: 300,
    usedPercent: 36, resetsAt: expired + 3600000,
  }];
  const events = [{
    ts: expired - 3600000, source: 'codex-cli', model: 'codex', project: null, session: null, requests: 1,
    tokens: withTotal({ output: 10000 }),
  }];
  const g = computeGauges(events, quota, {}, now).find((x) => x.id.startsWith('codex-'));
  assert.equal(g.percent, 0, 'la fenêtre s’est réinitialisée depuis, elle est vide');
  assert.equal(g.stale, false, 'plus de relevé « périmé » affiché tel quel');
});

// ---------------------------------------------------------------------------
// Le relevé en direct est un instantané, pas de l'historique. La première
// version l'empilait dans l'index (60 entrées en dix minutes) et martelait
// l'API à chaque cycle, ce qui a fini en 429 avec une jauge figée.
test('usage direct : un relevé frais fait autorité', () => {
  const now = Date.now();
  const events = [ev(now - 3600 * 1000, 'claude-opus-5', withTotal({ output: 50000 }))];
  const quota = [{ source: 'anthropic-oauth', ts: now - 60 * 1000, type: 'five_hour', usedPercent: 89, resetsAt: now + 3600000 }];
  const g = computeGauges(events, quota, {}, now).find((x) => x.id === 'anthropic-five_hour');
  assert.equal(g.limitSource, 'live');
  assert.equal(g.percent, 89);
  assert.equal(g.stale, false);
});

test('usage direct : passé le seuil de fraîcheur, le relevé n’est plus du direct', () => {
  const now = Date.now();
  const events = [ev(now - 3600 * 1000, 'claude-opus-5', withTotal({ output: 50000 }))];
  // Exprimé par rapport à la constante : un réglage de cadence ne doit pas
  // casser ce test, il doit seulement déplacer le seuil.
  const quota = [{ source: 'anthropic-oauth', ts: now - (LIVE_FRESH_MS + 60000), type: 'five_hour', usedPercent: 89, resetsAt: now + 3600000 }];
  const g = computeGauges(events, quota, {}, now).find((x) => x.id === 'anthropic-five_hour');
  // On continue de l'afficher — c'est la meilleure information disponible —
  // mais en disant son âge plutôt qu'en le faisant passer pour courant.
  assert.equal(g.limitSource, 'live-stale');
  assert.equal(g.stale, true);
  assert.equal(g.percent, 89);
  assert.ok(g.reportedAt, 'l’interface doit pouvoir afficher l’âge du relevé');
});

test('usage direct : la cadence d’interrogation évite de marteler l’API', async () => {
  const oauthCol = require('../src/core/collectors/anthropic-oauth');
  assert.ok(oauthCol.MIN_INTERVAL_MS >= 60000, 'un appel réseau par minute au maximum');
  assert.ok(oauthCol.FRESH_MS > oauthCol.MIN_INTERVAL_MS, 'un relevé doit rester valable au moins jusqu’au suivant');
  assert.equal(typeof oauthCol.resetCache, 'function', '« Actualiser » doit pouvoir forcer un relevé');
});

test('usage direct : le dernier relevé survit à un redémarrage', async () => {
  // Régression : le relevé n'était gardé qu'en mémoire du collecteur. Au
  // redémarrage il disparaissait, et la jauge retombait sur une estimation
  // fausse alors qu'un chiffre connu, même daté, valait bien mieux.
  const dir = tmpdir();
  const prevHome = process.env.TRACE_HOME;
  process.env.TRACE_HOME = dir;
  delete require.cache[require.resolve('../src/core/store')];
  const store = require('../src/core/store');

  const now = Date.now();
  const reading = { source: 'anthropic-oauth', ts: now - 5 * 60 * 1000, type: 'five_hour', usedPercent: 89, resetsAt: now + 3600000 };
  store.saveIndex({ version: 2, collectors: {}, events: [], quota: [reading] });

  const reloaded = store.loadIndex();
  const live = reloaded.quota.filter((q) => q.source === 'anthropic-oauth');
  assert.equal(live.length, 1, 'le relevé doit être sur le disque');
  assert.equal(live[0].usedPercent, 89);

  if (prevHome) process.env.TRACE_HOME = prevHome;
  else delete process.env.TRACE_HOME;
  delete require.cache[require.resolve('../src/core/store')];
  fs.rmSync(dir, { recursive: true, force: true });
});

test('usage direct : un relevé daté vaut mieux qu’une estimation fausse', () => {
  const now = Date.now();
  const events = [ev(now - 2 * 3600 * 1000, 'claude-opus-5', withTotal({ output: 500000 }))];
  const resetsAt = now - 3600 * 1000;
  const quota = [
    { source: 'claude-code', ts: resetsAt - 60000, type: 'five_hour', status: 'rejected', resetsAt, cause: 'window' },
    // Un relevé serveur, même vieux d'une heure, reste la meilleure source.
    { source: 'anthropic-oauth', ts: now - (LIVE_FRESH_MS + 60000), type: 'five_hour', usedPercent: 89, resetsAt: now + 3600000 },
  ];
  const g = computeGauges(events, quota, {}, now).find((x) => x.id === 'anthropic-five_hour');
  assert.equal(g.percent, 89, 'le relevé serveur doit primer même daté');
  assert.equal(g.limitSource, 'live-stale');
  assert.equal(g.approximate, false);
});

test('usage direct : « Actualiser » force vraiment un relevé', async () => {
  // Régression : `resetCache()` remettait `fetchedAt` à zéro, mais l'amorçage
  // depuis l'état persisté — ajouté plus tard contre le 429 — le restaurait
  // aussitôt. Le bouton était devenu un no-op silencieux.
  const col = require('../src/core/collectors/anthropic-oauth');
  col.resetCache();

  const recent = { fetchedAt: Date.now() - 5000, quota: [{ source: 'anthropic-oauth', ts: Date.now() - 5000, type: 'five_hour', usedPercent: 19 }], retryAfter: 0 };

  // Sans forçage : le relevé récent est réutilisé, aucun appel n'est tenté.
  const passive = await col.collect({}, recent);
  assert.equal(passive.stats.note, 'relevé récent réutilisé');

  // Avec forçage : la cadence est court-circuitée, un appel est tenté.
  col.resetCache();
  col.forceRefresh();
  const active = await col.collect({}, recent);
  assert.notEqual(active.stats.note, 'relevé récent réutilisé', 'le forçage doit passer outre la cadence');

  col.resetCache();
});

test('usage direct : le forçage ne passe pas outre un report après échec', async () => {
  // Insister sur un 429 ne fait que prolonger la sanction. L'interface doit
  // dire pourquoi rien ne bouge, pas retenter en boucle.
  const col = require('../src/core/collectors/anthropic-oauth');
  col.resetCache();
  col.forceRefresh();
  const res = await col.collect({}, { fetchedAt: Date.now() - 5000, quota: [], retryAfter: Date.now() + 600000 });
  assert.equal(res.stats.note, 'en attente après un échec');
  assert.ok(res.stats.nextAttemptIn > 0, 'le délai restant doit être exposé à l’interface');
  col.resetCache();
});

// ---------------------------------------------------------------------------
test('limites : le libellé suit la durée réelle de la fenêtre', () => {
  // Régression : tout ce qui dépassait 168 h s'appelait « Hebdomadaire ».
  // Le jour où Codex a ajouté une fenêtre de 43 200 min, deux lignes
  // homonymes se sont retrouvées côte à côte dans l'interface.
  assert.equal(durationLabel(5), 'Session 5 h');
  assert.equal(durationLabel(24), 'Quotidienne');
  assert.equal(durationLabel(168), 'Hebdomadaire');
  assert.equal(durationLabel(720), 'Mensuelle');
  assert.notEqual(durationLabel(720), durationLabel(168), 'deux durées ne doivent pas partager un libellé');
  assert.equal(durationLabel(336), '14 jours', 'une durée inattendue reste nommable');
});

test('limites : une fenêtre que le fournisseur ne rapporte plus disparaît', () => {
  const now = Date.now();
  const events = [{
    ts: now - 3600000, source: 'codex-cli', model: 'codex', project: null, session: null, requests: 1,
    tokens: withTotal({ output: 1000 }),
  }];
  const quota = [
    // Ancien jeu de fenêtres, plus rapporté depuis des semaines.
    { source: 'codex-cli', ts: now - 54 * 86400000, type: '300min', windowMinutes: 300, usedPercent: 36, resetsAt: now - 54 * 86400000 + 3600000 },
    { source: 'codex-cli', ts: now - 13 * 86400000, type: '10080min', windowMinutes: 10080, usedPercent: 5, resetsAt: now - 13 * 86400000 + 3600000 },
    // Relevé du jour : c'est lui qui fait référence.
    { source: 'codex-cli', ts: now - 60000, type: '43200min', windowMinutes: 43200, usedPercent: 14, resetsAt: now + 29 * 86400000 },
  ];
  const codex = computeGauges(events, quota, {}, now).filter((g) => g.id.startsWith('codex-'));
  assert.equal(codex.length, 1, 'les fenêtres obsolètes ne doivent plus produire de jauge');
  assert.equal(codex[0].label, 'Mensuelle');
  assert.equal(codex[0].percent, 14);
});

test('limites : des fenêtres relevées ensemble sont toutes conservées', () => {
  // Contre-épreuve : si Codex n'a pas servi depuis un mois, ses fenêtres sont
  // toutes également anciennes et aucune ne doit disparaître.
  const now = Date.now();
  const old = now - 30 * 86400000;
  const quota = [
    { source: 'codex-cli', ts: old, type: '300min', windowMinutes: 300, usedPercent: 36, resetsAt: old + 3600000 },
    { source: 'codex-cli', ts: old + 1000, type: '10080min', windowMinutes: 10080, usedPercent: 5, resetsAt: old + 3600000 },
  ];
  const codex = computeGauges([], quota, {}, now).filter((g) => g.id.startsWith('codex-'));
  assert.equal(codex.length, 2);
});

// ---------------------------------------------------------------------------
test('export : format long, une ligne par jour/source/modèle/projet', () => {
  const now = Date.now();
  const mk = (model, project, tokens) => ({
    ts: now - 3600000, source: 'claude-code', model, project, session: 's', requests: 1,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, ...tokens,
      total: (tokens.input || 0) + (tokens.output || 0) + (tokens.cacheRead || 0) + (tokens.cacheWrite || 0) },
  });
  const rows = exportRows([mk('claude-opus-5', 'a', { output: 100 }), mk('claude-sonnet-5', 'b', { output: 50 })],
    { from: now - 86400000, to: now });

  assert.equal(rows.length, 3, 'un en-tête et deux lignes');
  assert.equal(rows[0].length, 17);
  // Régression : la première version laissait huit colonnes sur treize vides
  // et mélangeait des lignes journalières avec des lignes « TOTAL ».
  for (const r of rows.slice(1)) {
    assert.equal(r.length, rows[0].length, 'toutes les lignes ont le même nombre de colonnes');
    assert.ok(r.every((c) => c !== '' && c != null), `cellule vide dans ${JSON.stringify(r)}`);
  }
  assert.ok(!rows.some((r) => r[0] === 'TOTAL'), 'aucune ligne de total mélangée aux données');
});

test('export : le CSV échappe les séparateurs et les guillemets', () => {
  const csv = toCsv([['a', 'b'], ['virgule, ici', 'guillemet " ici']]);
  const lines = csv.split('\n');
  assert.equal(lines[1], '"virgule, ici","guillemet "" ici"');
});

test('export : hors période, aucune ligne de données', () => {
  const now = Date.now();
  const old = {
    ts: now - 90 * 86400000, source: 'claude-code', model: 'claude-opus-5', project: 'p', session: 's', requests: 1,
    tokens: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, total: 10 },
  };
  assert.equal(exportRows([old], { from: now - 86400000, to: now }).length, 1);
});

// ---------------------------------------------------------------------------
const alerts = require('../src/core/alerts');

// Instants figés : `windowKey` dépend de `resetsAt`, donc un `Date.now()`
// recalculé à chaque appel produirait une fenêtre différente à chaque étape et
// rendrait le test non déterministe.
const T0 = 1788000000000;
const gauge = (over = {}) => ({
  id: 'anthropic-five_hour', product: 'Claude', label: 'Session 5 h',
  percent: 50, limitSource: 'live', approximate: false,
  resetsAt: T0 + 3600000, startsAt: T0 - 4 * 3600000, ...over,
});

test('alertes : un seuil ne se déclenche qu’une fois par fenêtre', () => {
  const now = T0;
  let state = {};
  const step = (percent) => {
    const r = alerts.evaluate([gauge({ percent })], {}, state, now);
    state = r.state;
    return r.notifications.map((n) => n.threshold);
  };
  assert.deepEqual(step(40), []);
  assert.deepEqual(step(82), [80]);
  assert.deepEqual(step(84), [], 'répéter à chaque cycle de 60 s ferait de l’outil une nuisance');
  assert.deepEqual(step(96), [95]);
  assert.deepEqual(step(97), []);
});

test('alertes : jamais sur une échelle approximative', () => {
  const now = T0;
  // Cette estimation s'est révélée fausse d'un facteur 2,6 en conditions
  // réelles. Une alerte fausse détruit la confiance dans toutes les autres.
  const r = alerts.evaluate([gauge({ percent: 99, limitSource: 'observed', approximate: true })], {}, {}, now);
  assert.equal(r.notifications.length, 0);
});

test('alertes : un bond de 0 à 96 % ne produit qu’une notification', () => {
  const r = alerts.evaluate([gauge({ percent: 96 })], {}, {}, T0);
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0].threshold, 95, 'le seuil le plus haut franchi');
});

test('alertes : une nouvelle fenêtre réarme les seuils', () => {
  const now = T0;
  const first = alerts.evaluate([gauge({ percent: 90, resetsAt: now + 1000 })], {}, {}, now);
  assert.equal(first.notifications.length, 1);
  // Même jauge, fenêtre suivante : le seuil doit pouvoir se redéclencher.
  const second = alerts.evaluate([gauge({ percent: 90, resetsAt: now + 5 * 3600000 })], {}, first.state, now);
  assert.equal(second.notifications.length, 1);
});

test('alertes : l’état des fenêtres mortes n’est pas conservé', () => {
  const now = T0;
  const r1 = alerts.evaluate([gauge({ percent: 90, resetsAt: now + 1000 })], {}, {}, now);
  assert.equal(Object.keys(r1.state).length, 1);
  // La jauge disparaît : son état ne doit pas s'accumuler indéfiniment.
  const r2 = alerts.evaluate([], {}, r1.state, now);
  assert.equal(Object.keys(r2.state).length, 0);
});

test('alertes : désactivables, et seuils personnalisables', () => {
  const now = T0;
  assert.equal(alerts.evaluate([gauge({ percent: 99 })], { alerts: { enabled: false } }, {}, now).notifications.length, 0);
  const custom = alerts.evaluate([gauge({ percent: 55 })], { alerts: { thresholds: [50] } }, {}, now);
  assert.deepEqual(custom.notifications.map((n) => n.threshold), [50]);
});

test('persistance : l’index n’est pas réécrit sans changement', () => {
  const idx = { events: [{ ts: 1000 }], quota: [], collectors: { a: { offset: 1 } } };
  const a = store.indexSignature(idx, 365);
  const b = store.indexSignature({ ...idx }, 365);
  assert.equal(a, b, 'même contenu, même signature');
  const c = store.indexSignature({ ...idx, events: [{ ts: 1000 }, { ts: 2000 }] }, 365);
  assert.notEqual(a, c, 'un nouvel événement doit forcer l’écriture');
});

// ---------------------------------------------------------------------------
test('usage direct : un report hérité conserve son motif', async () => {
  // Régression : `retryAfter` était persisté mais pas `lastError`. Au
  // redémarrage, l'application héritait donc d'une attente MUETTE — plus de
  // mise à jour, et rien pour l'expliquer.
  const col = require('../src/core/collectors/anthropic-oauth');
  col.resetCache();
  const res = await col.collect({}, {
    fetchedAt: Date.now() - 60000,
    quota: [{ source: 'anthropic-oauth', ts: Date.now() - 60000, type: 'five_hour', usedPercent: 54 }],
    retryAfter: Date.now() + 300000,
    lastError: 'Anthropic 429',
    failures: 1,
  });
  assert.equal(res.stats.note, 'en attente après un échec');
  assert.deepEqual(res.stats.errors, ['Anthropic 429']);
  assert.ok(res.stats.nextAttemptIn > 0);
  assert.equal(res.quota.length, 1, 'le dernier relevé connu reste affiché');
  col.resetCache();
});

test('usage direct : un report sans motif se signale quand même', async () => {
  const col = require('../src/core/collectors/anthropic-oauth');
  col.resetCache();
  const res = await col.collect({}, {
    fetchedAt: Date.now() - 60000, quota: [], retryAfter: Date.now() + 300000,
  });
  assert.equal(res.stats.errors.length, 1, '« rien ne bouge » sans explication est le pire cas');
  col.resetCache();
});

test('usage direct : une coupure passagère ne punit pas comme un 429', () => {
  const col = require('../src/core/collectors/anthropic-oauth');
  // Dix minutes d'attente pour une micro-coupure réseau laisseraient
  // l'utilisateur devant un chiffre figé sans raison valable.
  assert.ok(col.BACKOFF_TRANSIENT_MS < col.BACKOFF_RATE_LIMIT_MS / 5);
  assert.ok(col.BACKOFF_TRANSIENT_MS >= 30000, 'mais pas de nouvelle tentative immédiate');
});

// ---------------------------------------------------------------------------
test('registre : un modèle Grok a un coût INCONNU, pas nul', () => {
  const m = resolveModel('grok-build');
  assert.equal(m.provider, 'xai');
  // Les tarifs xAI ne sont pas exposés par le CLI. `null` reste visible comme
  // « coût inconnu » dans l'interface ; 0 aurait été un mensonge.
  assert.equal(cost({ input: 1e6, output: 1e6 }, m), null);
  assert.ok(m.params.active.max > 0, 'l’estimation carbone reste possible');
});

test('collecteur Grok : déclare ne pas fournir de tokens', () => {
  const grok = require('../src/core/collectors/grok-cli');
  assert.equal(grok.providesTokens, false);
  // Aucun compteur n'existe côté Grok CLI : extrapoler depuis la longueur des
  // messages produirait un chiffre faux présenté comme une mesure.
  const r = grok.collect({ grokDir: tmpdir() });
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.quota, []);
});

test('collecteur Grok : un index illisible ne fait pas tomber le collecteur', () => {
  const grok = require('../src/core/collectors/grok-cli');
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', 'session_search.sqlite'), 'ceci n\'est pas une base');
  const r = grok.collect({ grokDir: dir });
  assert.equal(r.stats.sqlite, false, 'l’échec est signalé, pas propagé');
  assert.deepEqual(r.events, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
