'use strict';

const { collectAll } = require('./collectors');
const { report, exportRows, methodologyRows, toCsv } = require('./aggregate');
const { computeGauges, applyUserCalibration } = require('./ratelimits');
const store = require('./store');
const carbon = require('./carbon');
const alerts = require('./alerts');
const provenance = require('./provenance');
const { t } = require('../i18n');
const { resolveModel } = require('./models');

/**
 * Façade du cœur métier : un seul point d'entrée pour l'application Electron
 * comme pour la CLI. Aucune dépendance à Electron ici — c'est ce qui rend le
 * tout testable en `node --test` sans lancer d'interface.
 */

/**
 * Fusionne de nouveaux enregistrements avec ceux déjà indexés, sans doublon.
 *
 * Les collecteurs reprennent leur lecture à un offset et ne renvoient donc en
 * principe que du nouveau. Cette clé de secours protège malgré tout du cas où
 * un fichier tronqué force un ré-scan complet depuis le début.
 */
function mergeRecords(existing, incoming, keyFn) {
  if (!existing || !existing.length) return incoming;
  if (!incoming.length) return existing;
  const seen = new Set(existing.map(keyFn));
  const added = incoming.filter((r) => !seen.has(keyFn(r)));
  return added.length ? existing.concat(added).sort((a, b) => a.ts - b.ts) : existing;
}

const eventKey = (e) => `${e.source}|${e.ts}|${e.session || ''}|${(e.tokens && e.tokens.total) || 0}`;
const quotaKey = (q) => `${q.source}|${q.ts}|${q.type}|${q.resetsAt || ''}`;

/**
 * Rafraîchit toutes les sources et renvoie l'instantané complet consommé par
 * l'interface.
 */
async function refresh(options = {}) {
  const config = options.config || store.loadConfig();
  const idx = options.index || store.loadIndex(config);

  const collected = await collectAll(config, idx.collectors || {});

  // Deux régimes de fusion, parce que deux natures d'enregistrement.
  //
  // Un événement de requête s'AJOUTE : il décrit un fait passé, définitif.
  // Un agrégat journalier se REMPLACE : il décrit l'état d'une journée, et
  // celui de la journée en cours grossit d'un relevé à l'autre. Les fusionner
  // sous la même règle faisait empiler les états successifs du jour au lieu
  // de les corriger — à une minute de cadence, la journée courante finissait
  // comptée plus de mille fois, en totaux croissants.
  const previous = idx.events || [];
  // En deçà de cette borne, l'index ne garde plus que des agrégats horaires.
  // Une relecture complète des journaux — provoquée par un élargissement de
  // la rétention ou par un fichier tronqué — y ramènerait le détail déjà
  // replié, qui s'ajouterait à son propre agrégat. On l'écarte à l'entrée.
  const compactedThrough = idx.compactedThrough || 0;
  const streamEvents = mergeRecords(
    previous.filter((e) => !provenance.isDailyGrain(e.source)),
    collected.events.filter((e) => !provenance.isDailyGrain(e.source) && e.ts >= compactedThrough),
    eventKey
  );
  const dailyEvents = provenance.mergeDaily(
    previous.filter((e) => provenance.isDailyGrain(e.source)),
    collected.events.filter((e) => provenance.isDailyGrain(e.source))
  );
  const events = dailyEvents.length
    ? streamEvents.concat(dailyEvents).sort((a, b) => a.ts - b.ts)
    : streamEvents;

  // Les relevés de quota en direct sont des INSTANTANÉS, pas de l'historique :
  // on n'en garde que le PLUS RÉCENT par fenêtre. Les empiler donnait 60
  // entrées en dix minutes ; ne pas les garder du tout faisait perdre le
  // dernier chiffre connu au redémarrage, et la jauge retombait sur une
  // estimation fausse. Un par fenêtre, remplacé à chaque relevé : borné, et
  // qui survit à un redémarrage.
  const isLive = (q) => q.source === 'anthropic-oauth';
  const history = mergeRecords(
    (idx.quota || []).filter((q) => !isLive(q)),
    collected.quota.filter((q) => !isLive(q)),
    quotaKey
  );

  const newestLive = new Map();
  for (const q of [...(idx.quota || []).filter(isLive), ...collected.quota.filter(isLive)]) {
    const cur = newestLive.get(q.type);
    if (!cur || q.ts > cur.ts) newestLive.set(q.type, q);
  }
  const live = [...newestLive.values()];
  const quota = history.concat(live);

  let nextIndex = { version: 2, collectors: collected.state, events, quota, compactedThrough };
  // `saveIndex` applique la rétention. On renvoie l'index RETENU, pas celui
  // d'avant élagage : sinon la vue en mémoire et le fichier divergent, et le
  // nombre d'événements changerait tout seul au redémarrage suivant.
  if (options.persist !== false) {
    nextIndex = store.saveIndex(nextIndex, config);
    nextIndex.collectors = collected.state;
  }

  return {
    config,
    index: nextIndex,
    events: nextIndex.events,
    quota: nextIndex.quota,
    sources: collected.sources,
    extra: collected.extra,
  };
}

/** Construit l'instantané destiné à l'affichage (jauges + rapport). */
function snapshot(state, options = {}) {
  const config = state.config || store.loadConfig();
  const to = options.to || Date.now();

  // Horizon réel : jusqu'où les sources permettent de remonter. Sans cette
  // information, une période d'un an paraît vide « à cause de TRACE », alors
  // que c'est Claude Code qui purge ses sessions au bout de deux mois.
  const horizon = { from: null, bySource: {} };
  for (const e of state.events || []) {
    if (horizon.from == null || e.ts < horizon.from) horizon.from = e.ts;
    const cur = horizon.bySource[e.source];
    if (cur == null || e.ts < cur) horizon.bySource[e.source] = e.ts;
  }

  // `days: 'all'` remonte aussi loin que les données le permettent.
  const all = options.days === 'all';
  const days = all ? null : options.days || config.defaultRangeDays || 30;
  const from = options.from || (all ? horizon.from || to - 30 * 86400000 : to - days * 86400000);

  const opts = {
    from,
    to,
    carbon: { gridKey: (config.carbon || {}).gridKey, pue: (config.carbon || {}).pue },
    modelOverrides: config.modelOverrides,
  };

  const rep = report(state.events, opts);
  const gauges = computeGauges(state.events, state.quota, config, to);

  // Les collecteurs reprennent leur lecture à un offset : le nombre
  // d'événements qu'ils viennent de renvoyer est un DELTA, pas un total.
  // L'afficher tel quel donnerait « Claude Code — 4 » sur une base de 6 000.
  const indexedBySource = new Map();
  const rangeBySource = new Map();
  for (const e of state.events || []) {
    indexedBySource.set(e.source, (indexedBySource.get(e.source) || 0) + 1);
    if (e.ts >= from && e.ts <= to) rangeBySource.set(e.source, (rangeBySource.get(e.source) || 0) + 1);
  }
  const sources = (state.sources || []).map((s) => ({
    ...s,
    newEvents: s.events,
    events: indexedBySource.get(s.id) || 0,
    eventsInRange: rangeBySource.get(s.id) || 0,
  }));

  // Une période de comparaison presque vide produit des variations absurdes
  // (+15 000 %). On la signale plutôt que de l'afficher telle quelle.
  const prevTotal = rep.trend.previous.tokens.total;
  rep.trend.significant = prevTotal > Math.max(1000, rep.totals.tokens.total * 0.02);

  // État de la source directe, remonté tel quel : quand un report après échec
  // est en cours, l'interface doit pouvoir dire pourquoi le chiffre ne bouge
  // pas, au lieu de laisser croire à un blocage inexpliqué.
  const liveSource = sources.find((x) => x.id === 'anthropic-oauth');
  const liveStats = (liveSource && liveSource.stats) || {};
  const nextAttemptIn = liveStats.nextAttemptIn || 0;
  // Attendre la cadence normale n'est PAS une panne. Confondre les deux
  // faisait annoncer « relevé suspendu après un échec » à chaque quart d'heure
  // ordinaire ; ne regarder que le report d'échec, à l'inverse, laissait le
  // régime normal totalement muet — c'est ce second travers qui donnait une
  // jauge figée sans la moindre explication.
  const waiting = nextAttemptIn > 0 && liveStats.nextAttemptReason === 'backoff';
  const pacing = nextAttemptIn > 0 && liveStats.nextAttemptReason === 'cadence';
  const liveStatus = liveSource
    ? {
        // Une source en attente après un échec n'est PAS « ok » : la première
        // version ne regardait que `error`, or un report hérité d'un
        // redémarrage n'a pas de motif. L'interface n'affichait donc rien et
        // l'utilisateur voyait un chiffre figé sans explication.
        ok: !liveSource.error && !waiting,
        waiting,
        // La cadence se dit sur la jauge elle-même, pas dans un bandeau
        // d'alerte : c'est le fonctionnement nominal.
        pacing,
        error: liveSource.error || (waiting ? t('oauth.suspended') : null),
        ageMs: liveStats.ageMs,
        nextAttemptIn,
      }
    : null;

  // La jauge en direct porte l'échéance du prochain relevé : sans elle, un
  // pourcentage qui ne bouge pas pendant un quart d'heure se lit comme une
  // panne, alors que c'est la cadence qui protège du 429.
  if (nextAttemptIn > 0) {
    for (const g of gauges) {
      if (g.limitSource === 'live' || g.limitSource === 'live-stale') g.nextLiveIn = nextAttemptIn;
    }
  }

  // La méthodologie voyage AVEC le chiffre. La construire et ne jamais la
  // montrer revenait à demander à l'utilisateur de croire un total dont il ne
  // pouvait vérifier aucun terme ; c'est exactement ce qu'un chiffre carbone ne
  // doit pas être.
  const methodology = {
    factors: carbon.factorTable({ gridKey: (config.carbon || {}).gridKey }),
    unpinned: carbon.unpinnedSources(),
    grids: carbon.GRID_INTENSITY,
    providers: carbon.PROVIDER_INFRA,
  };

  return {
    generatedAt: Date.now(),
    methodology,
    range: { from, to, days: days || Math.round((to - from) / 86400000), all },
    dataHorizon: horizon,
    liveStatus,
    report: rep,
    gauges,
    sources,
    extra: state.extra || {},
    config: { ...config, anthropicAdminKey: null, openaiAdminKey: null }, // jamais de clé vers le renderer
    hasKeys: {
      anthropic: !!config.anthropicAdminKey,
      openai: !!config.openaiAdminKey,
    },
  };
}

/**
 * Recale une jauge sur un pourcentage relevé par l'utilisateur et enregistre
 * la configuration. C'est la seule voie exacte côté Anthropic : le vrai
 * pourcentage n'existe nulle part en local.
 */
function calibrate(state, gaugeId, percent) {
  const config = store.loadConfig();
  const updated = applyUserCalibration(config, state.events, state.quota, gaugeId, percent);
  store.saveConfig(updated);
  return updated;
}

module.exports = { refresh, snapshot, store, carbon, alerts, resolveModel, report, computeGauges, calibrate, exportRows, methodologyRows, toCsv };
