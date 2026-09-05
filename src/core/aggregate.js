'use strict';

const { emptyTokens, addTokens, dayKey } = require('./util');
const { resolveModel } = require('./models');
const { cost, costWithoutCache } = require('./pricing');
const carbon = require('./carbon');
const provenance = require('./provenance');

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

  // Le chiffre facturé et la mesure locale décrivent les MÊMES requêtes : les
  // sommer doublait le total dès qu'une clé Admin était renseignée. On écarte
  // le doublon avant toute agrégation, et sur l'historique complet plutôt que
  // sur la période affichée — sinon la même journée serait retenue ou écartée
  // selon le sélecteur de période, et le total bougerait sans raison visible.
  const { events: measured, dropped } = provenance.dedupeFamilies(events);
  const inRange = measured.filter((e) => e.ts >= from && e.ts <= to);

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

  // Un total carbone unique n'est pas défendable : il repose sur une hypothèse
  // de localisation et sur des tailles de modèles non publiées. On livre donc
  // avec le total ce qui permet de le contester — le même chiffre sous
  // plusieurs mix, et le poids respectif de chaque hypothèse.
  const pairs = byModel
    .filter((g) => g.models.length && g.tokens.total > 0)
    .map((g) => ({ tokens: g.tokens, model: g.models[0].model }));
  totals.carbonSensitivity = pairs.length ? carbon.gridSensitivity(pairs, opts.carbon || {}) : [];
  totals.carbonUncertainty = pairs.length ? carbon.uncertainty(pairs, opts.carbon || {}) : [];
  totals.cacheSavingsUSD = Math.max(0, totals.costWithoutCacheUSD - totals.costUSD);
  totals.cacheHitRatio =
    totals.tokens.cacheRead + totals.tokens.input + totals.tokens.cacheWrite > 0
      ? totals.tokens.cacheRead / (totals.tokens.cacheRead + totals.tokens.input + totals.tokens.cacheWrite)
      : 0;

  // Période précédente de même durée, pour afficher une tendance.
  const span = to - from;
  const prevEvents = measured.filter((e) => e.ts >= from - span && e.ts < from);
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
    // Confrontation mesure locale / chiffre facturé : elle se construit sur
    // les événements BRUTS, puisque son objet est précisément l'écart entre
    // les deux vues qu'on vient de départager.
    reconciliation: provenance.reconciliation(events, from, to),
    billedDaysDropped: dropped,
  };
}

/**
 * Lignes d'export, en format long : une ligne par (jour, source, modèle,
 * projet), toutes colonnes renseignées.
 *
 * La première version mélangeait deux tables dans un même fichier — des lignes
 * journalières dont huit colonnes sur treize restaient vides, suivies de
 * lignes « TOTAL » par modèle. Illisible par un tableur, et inexploitable en
 * tableau croisé. Un format long se pivote, se filtre et se somme sans
 * retraitement.
 */
function exportRows(events, opts = {}) {
  const to = opts.to || Date.now();
  const from = opts.from || to - 30 * 86400000;
  // Même départage que le rapport : un export qui compterait deux fois les
  // mêmes requêtes serait pire qu'un affichage faux, puisqu'il survit à
  // l'application et part dans un tableur.
  const inRange = provenance.dedupeFamilies(events).events.filter((e) => e.ts >= from && e.ts <= to);

  const groups = groupBy(
    inRange,
    (e) => `${dayKey(e.ts)}\u0000${e.source}\u0000${e.model}\u0000${e.project || ''}`,
    opts
  );

  const rows = [[
    'date', 'source', 'modele', 'fournisseur', 'projet',
    'requetes', 'tokens_entree', 'tokens_sortie', 'cache_ecrit', 'cache_lu', 'tokens_total',
    'cout_usd', 'cout_sans_cache_usd', 'gco2e_min', 'gco2e_median', 'gco2e_max', 'energie_wh', 'eau_l',
  ]];

  for (const g of groups) {
    const [date, source, model, project] = g.key.split('\u0000');
    const m = g.models[0];
    rows.push([
      date, source, m ? m.label : model, m ? m.provider : '', project,
      g.requests,
      g.tokens.input, g.tokens.output, g.tokens.cacheWrite, g.tokens.cacheRead, g.tokens.total,
      g.costUnknown ? '' : g.costUSD.toFixed(6),
      g.costWithoutCacheUSD.toFixed(6),
      g.carbon.gramsCO2e.min.toFixed(3),
      g.carbon.gramsCO2e.mid.toFixed(3),
      g.carbon.gramsCO2e.max.toFixed(3),
      g.carbon.energyWh.mid.toFixed(3),
      g.carbon.waterL.mid.toFixed(3),
    ]);
  }

  // Ordre chronologique puis décroissant en volume : lisible tel quel.
  const body = rows.slice(1).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || b[10] - a[10]);
  return [rows[0], ...body];
}

/**
 * Annexe méthodologique : un facteur par ligne, avec sa citation.
 *
 * Se joint à l'export de données. Un tableau de grammes sans les facteurs qui
 * l'ont produit n'est pas vérifiable — et la colonne `version_figee` dit, ligne
 * à ligne, ce qui reste à relever sur la publication avant un usage audité.
 */
function methodologyRows(opts = {}) {
  const rows = [['groupe', 'facteur', 'valeur', 'unite', 'source', 'citation', 'version_figee', 'reserve']];
  for (const r of carbon.factorTable(opts)) {
    rows.push([r.group, r.key, r.value, r.unit, r.source, r.citation, r.pinned ? 'oui' : 'non', r.note || '']);
  }
  return rows;
}

/** Sérialise en CSV, avec échappement RFC 4180. */
function toCsv(rows) {
  return rows
    .map((r) => r.map((c) => (/[",;\n\r]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(','))
    .join('\n');
}

module.exports = { report, groupBy, dailySeries, hourHistogram, exportRows, methodologyRows, toCsv };
