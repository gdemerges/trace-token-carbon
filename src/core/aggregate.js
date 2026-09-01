'use strict';

const { emptyTokens, addTokens, dayKey } = require('./util');
const { resolveModel } = require('./models');
const { cost, costWithoutCache } = require('./pricing');
const carbon = require('./carbon');

/**
 * Transforme une liste brute d'événements en tous les agrégats dont
 * l'interface a besoin.
 *
 * Principe directeur : le coût et le carbone sont calculés PAR MODÈLE puis
 * sommés, jamais sur un total de tokens agrégé. Additionner d'abord les tokens
 * de modèles différents puis appliquer un tarif moyen donnerait un résultat
 * faux dès que l'usage est réparti sur plusieurs modèles — ce qui est le cas
 * normal.
 */

function newBucket(extra = {}) {
  return { tokens: emptyTokens(), requests: 0, costUSD: 0, costUnknown: false, carbon: null, ...extra };
}

/** Applique coût et carbone à un groupe homogène en modèle. */
function finalizeModelBucket(bucket, modelId, opts) {
  const model = resolveModel(modelId, opts.modelOverrides);
  const c = cost(bucket.tokens, model);
  bucket.costUSD = c == null ? 0 : c;
  bucket.costUnknown = c == null;
  bucket.costWithoutCacheUSD = costWithoutCache(bucket.tokens, model) || 0;
  bucket.carbon = carbon.estimate(bucket.tokens, model, opts.carbon || {});
  bucket.model = model;
  return bucket;
}

/**
 * Agrège une collection d'événements groupés par une clé arbitraire, en
 * conservant la ventilation par modèle à l'intérieur de chaque groupe pour
 * pouvoir chiffrer correctement.
 */
function groupBy(events, keyFn, opts) {
  const groups = new Map();

  for (const e of events) {
    const key = keyFn(e);
    if (key == null) continue;
    let g = groups.get(key);
    if (!g) {
      g = newBucket({ key, models: new Map() });
      groups.set(key, g);
    }
    addTokens(g.tokens, e.tokens);
    g.requests += e.requests || 1;

    let m = g.models.get(e.model);
    if (!m) {
      m = newBucket();
      g.models.set(e.model, m);
    }
    addTokens(m.tokens, e.tokens);
    m.requests += e.requests || 1;
  }

  // Chiffrage : par modèle, puis somme. Jamais l'inverse.
  const out = [];
  for (const g of groups.values()) {
    const modelBuckets = [];
    for (const [modelId, mb] of g.models) modelBuckets.push(finalizeModelBucket(mb, modelId, opts));

    g.costUSD = modelBuckets.reduce((s, m) => s + m.costUSD, 0);
    g.costUnknown = modelBuckets.some((m) => m.costUnknown);
    g.costWithoutCacheUSD = modelBuckets.reduce((s, m) => s + m.costWithoutCacheUSD, 0);
    g.carbon = carbon.sum(modelBuckets.map((m) => m.carbon));
    g.models = modelBuckets
      .map((m) => ({ id: m.model.id, label: m.model.label, provider: m.model.provider, ...m }))
      .sort((a, b) => b.tokens.total - a.tokens.total);
    out.push(g);
  }
  return out;
}

/** Série journalière continue : les jours sans usage valent zéro, pas un trou. */
function dailySeries(events, from, to, opts) {
  const byDay = new Map(groupBy(events, (e) => dayKey(e.ts), opts).map((g) => [g.key, g]));
  const series = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);

  while (cursor <= end) {
    const key = dayKey(cursor.getTime());
    const g = byDay.get(key);
    series.push({
      date: key,
      ts: cursor.getTime(),
      tokens: g ? g.tokens : emptyTokens(),
      requests: g ? g.requests : 0,
      costUSD: g ? g.costUSD : 0,
      gramsCO2e: g ? g.carbon.gramsCO2e.mid : 0,
      models: g ? g.models.map((m) => ({ id: m.id, label: m.label, total: m.tokens.total })) : [],
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return series;
}

/**
 * Répartition par heure locale — révèle les rythmes de travail.
 *
 * Passe par `groupBy` comme la série journalière, et non par une simple somme
 * de tokens : le coût et le carbone doivent être calculés PAR MODÈLE puis
 * sommés. Une heure où l'on a mélangé Opus et Sonnet n'a pas de tarif moyen
 * qui veuille dire quelque chose.
 */
function hourHistogram(events, opts = {}) {
  const byHour = new Map(groupBy(events, (e) => new Date(e.ts).getHours(), opts).map((g) => [g.key, g]));
  return Array.from({ length: 24 }, (_, hour) => {
    const g = byHour.get(hour);
    return {
      hour,
      tokens: g ? g.tokens.total : 0,
      requests: g ? g.requests : 0,
      costUSD: g ? g.costUSD : 0,
      gramsCO2e: g ? g.carbon.gramsCO2e.mid : 0,
    };
  });
}

/**
 * Rapport complet sur une période.
 * @param {Array} events  événements normalisés
 * @param {object} opts   {from, to, carbon:{gridKey,...}, modelOverrides}
 */
function report(events, opts = {}) {
  const to = opts.to || Date.now();
  const from = opts.from || to - 30 * 86400000;
  const inRange = events.filter((e) => e.ts >= from && e.ts <= to);

  const byModel = groupBy(inRange, (e) => e.model, opts).sort((a, b) => b.tokens.total - a.tokens.total);
  const bySource = groupBy(inRange, (e) => e.source, opts).sort((a, b) => b.tokens.total - a.tokens.total);
  const byProject = groupBy(inRange, (e) => e.project || 'sans projet', opts).sort((a, b) => b.tokens.total - a.tokens.total);
  const bySession = groupBy(inRange, (e) => e.session, opts).sort((a, b) => b.tokens.total - a.tokens.total);

  const totals = {
    tokens: emptyTokens(),
    requests: 0,
    costUSD: 0,
    costUnknown: false,
    costWithoutCacheUSD: 0,
  };
  for (const g of byModel) {
    addTokens(totals.tokens, g.tokens);
    totals.requests += g.requests;
    totals.costUSD += g.costUSD;
    totals.costWithoutCacheUSD += g.costWithoutCacheUSD;
    totals.costUnknown = totals.costUnknown || g.costUnknown;
  }
  totals.carbon = carbon.sum(byModel.map((g) => g.carbon));
  totals.equivalents = carbon.equivalents(totals.carbon.gramsCO2e.mid);
  totals.cacheSavingsUSD = Math.max(0, totals.costWithoutCacheUSD - totals.costUSD);
  totals.cacheHitRatio =
    totals.tokens.cacheRead + totals.tokens.input + totals.tokens.cacheWrite > 0
      ? totals.tokens.cacheRead / (totals.tokens.cacheRead + totals.tokens.input + totals.tokens.cacheWrite)
      : 0;

  // Période précédente de même durée, pour afficher une tendance.
  const span = to - from;
  const prevEvents = events.filter((e) => e.ts >= from - span && e.ts < from);
  const prevTokens = emptyTokens();
  let prevCost = 0;
  const prevByModel = groupBy(prevEvents, (e) => e.model, opts);
  for (const g of prevByModel) {
    addTokens(prevTokens, g.tokens);
    prevCost += g.costUSD;
  }
  const prevCarbon = carbon.sum(prevByModel.map((g) => g.carbon));

  const pctChange = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);

  return {
    range: { from, to },
    totals,
    trend: {
      tokens: pctChange(totals.tokens.total, prevTokens.total),
      cost: pctChange(totals.costUSD, prevCost),
      carbon: pctChange(totals.carbon.gramsCO2e.mid, prevCarbon.gramsCO2e.mid),
      previous: { tokens: prevTokens, costUSD: prevCost, carbon: prevCarbon },
    },
    byModel,
    bySource,
    byProject: byProject.slice(0, 20),
    topSessions: bySession.slice(0, 10),
    daily: dailySeries(inRange, from, to, opts),
    hours: hourHistogram(inRange, opts),
    eventCount: inRange.length,
  };
}

module.exports = { report, groupBy, dailySeries, hourHistogram };
