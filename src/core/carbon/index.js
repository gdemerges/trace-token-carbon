'use strict';

const {
  ECOLOGITS: E,
  TOKEN_ENERGY_WEIGHTS,
  PROVIDER_INFRA,
  WATER,
  GRID_INTENSITY,
  DEFAULT_GRID,
  GRID_SENSITIVITY,
  EQUIVALENTS,
  factorTable,
} = require('./factors');
const { SOURCES, cite, unpinnedSources } = require('./sources');

/**
 * Estimateur d'empreinte carbone d'inférence LLM (méthodologie EcoLogits,
 * étendue par TRACE pour prendre en compte les tokens d'entrée et de cache).
 *
 * Tout est calculé DEUX fois, sur la borne basse et la borne haute des
 * paramètres estimés et des poids énergétiques : la sortie est une fourchette,
 * jamais un point. C'est le seul honnête — les paramètres des modèles fermés
 * ne sont pas publics.
 */

/**
 * Énergie et durée d'une génération, pour un jeu d'hypothèses donné (une borne).
 * @returns {{energyWh:number, latencyS:number, gpuCount:number}}
 */
function computeBound({ tokens, totalParamsB, activeParamsB, weights, pue, gpuMemoryGb }) {
  // Nombre de GPU nécessaires pour héberger les poids quantifiés.
  const requiredMemoryGb = (totalParamsB * E.MODEL_QUANTIZATION_BITS) / 8;
  const gpuCount = Math.max(1, Math.ceil(requiredMemoryGb / gpuMemoryGb));

  // Un « token de sortie équivalent » : on convertit chaque classe de token en
  // son équivalent-décodage via les poids énergétiques.
  const equivalentOutputTokens =
    tokens.output * weights.output +
    tokens.input * weights.input +
    tokens.cacheWrite * weights.cacheWrite +
    tokens.cacheRead * weights.cacheRead;

  // Énergie GPU : linéaire en paramètres actifs. Attention, cette corrélation
  // rend DÉJÀ l'énergie de l'ensemble des GPU servant le modèle — ne pas la
  // remultiplier par `gpuCount`. Vérification physique : à 70 Md de paramètres
  // actifs elle donne 7,7 mWh/token, soit ~28 J, ce qui correspond bien à deux
  // A100 à 400 W débitant ~30 tokens/s.
  const gpuEnergyPerTokenWh = E.GPU_ENERGY_ALPHA * activeParamsB + E.GPU_ENERGY_BETA;
  const gpuEnergyWh = equivalentOutputTokens * gpuEnergyPerTokenWh;

  // Latence : sert à amortir le reste du serveur et la fabrication du matériel.
  const latencyPerTokenS = E.GPU_LATENCY_ALPHA * activeParamsB + E.GPU_LATENCY_BETA;
  const latencyS = equivalentOutputTokens * latencyPerTokenS;

  // Le reste du serveur (CPU, RAM, réseau, alim) au prorata des GPU utilisés.
  const serverEnergyWh = (latencyS / 3600) * E.SERVER_POWER_W * (gpuCount / E.SERVER_GPU_COUNT);

  // Le PUE couvre le refroidissement et les pertes de distribution du datacenter.
  const itEnergyWh = gpuEnergyWh + serverEnergyWh;
  const energyWh = pue * itEnergyWh;

  // `itEnergyWh` sert à l'empreinte eau : le WUE annoncé par les exploitants se
  // rapporte à l'énergie INFORMATIQUE, pas à l'énergie au compteur.
  return { energyWh, itEnergyWh, latencyS, gpuCount };
}

/** Impact de fabrication du matériel, amorti sur le temps d'occupation. */
function embodiedGramsCO2e(latencyS, gpuCount) {
  const serverShareKg = E.SERVER_EMBODIED_GWP_KG * (gpuCount / E.SERVER_GPU_COUNT);
  const gpuShareKg = E.GPU_EMBODIED_GWP_KG * gpuCount;
  const amortized = (serverShareKg + gpuShareKg) * (latencyS / E.HARDWARE_LIFESPAN_S);
  return amortized * 1000; // kg -> g
}

/**
 * Estime l'empreinte d'un volume de tokens sur un modèle donné.
 *
 * @param {object} tokens  {input, output, cacheWrite, cacheRead}
 * @param {object} model   enregistrement issu de models.js
 * @param {object} [opts]  {gridKey, gridIntensity, pue, weights, params}
 * @returns {{gramsCO2e:{min,max,mid}, energyWh:{min,max,mid}, waterL:{min,max,mid}, usageG, embodiedG, gpuCount, gridIntensity, gridLabel, confidence, infra}}
 */
function estimate(tokens, model, opts = {}) {
  const t = {
    input: tokens.input || 0,
    output: tokens.output || 0,
    cacheWrite: tokens.cacheWrite || 0,
    cacheRead: tokens.cacheRead || 0,
  };

  // L'infrastructure dépend du fournisseur : PUE, eau de refroidissement,
  // localisation par défaut. Un fournisseur inconnu prend la fourchette la plus
  // ouverte plutôt que l'hypothèse la plus flatteuse.
  const infra = PROVIDER_INFRA[model.provider] || PROVIDER_INFRA.unknown;

  // Un PUE forcé par l'utilisateur écrase la fourchette du fournisseur : c'est
  // un choix explicite, on ne le noie pas dans une plage.
  const pueLow = opts.pue != null ? opts.pue : infra.pue.min;
  const pueHigh = opts.pue != null ? opts.pue : infra.pue.max;
  const gpuMemoryGb = infra.gpuMemoryGb || E.GPU_MEMORY_GB;

  const gridKey = opts.gridKey || infra.gridKey || DEFAULT_GRID.cloud;
  const gridIntensity =
    opts.gridIntensity != null
      ? opts.gridIntensity
      : (GRID_INTENSITY[gridKey] || GRID_INTENSITY[DEFAULT_GRID.cloud]).value;
  const gridLabel = (GRID_INTENSITY[gridKey] || {}).label || 'Personnalisé';

  const w = opts.weights || TOKEN_ENERGY_WEIGHTS;
  const lowWeights = { output: w.output.min, input: w.input.min, cacheWrite: w.cacheWrite.min, cacheRead: w.cacheRead.min };
  const highWeights = { output: w.output.max, input: w.input.max, cacheWrite: w.cacheWrite.max, cacheRead: w.cacheRead.max };

  const p = opts.params || model.params;
  const low = computeBound({ tokens: t, totalParamsB: p.total.min, activeParamsB: p.active.min, weights: lowWeights, pue: pueLow, gpuMemoryGb });
  const high = computeBound({ tokens: t, totalParamsB: p.total.max, activeParamsB: p.active.max, weights: highWeights, pue: pueHigh, gpuMemoryGb });

  const toGrams = (b) => (b.energyWh / 1000) * gridIntensity + embodiedGramsCO2e(b.latencyS, b.gpuCount);

  // Eau : le refroidissement se rapporte à l'énergie informatique (c'est la
  // définition du WUE), la production d'électricité à l'énergie au compteur.
  const toWaterL = (b, wue, offsite) => (b.itEnergyWh / 1000) * wue + (b.energyWh / 1000) * offsite;

  const gMin = toGrams(low);
  const gMax = toGrams(high);
  const eMin = low.energyWh;
  const eMax = high.energyWh;
  const wMin = toWaterL(low, infra.wueL.min, WATER.OFFSITE_L_PER_KWH.min);
  const wMax = toWaterL(high, infra.wueL.max, WATER.OFFSITE_L_PER_KWH.max);

  // Point médian : moyenne géométrique, plus fidèle qu'une moyenne
  // arithmétique quand les bornes couvrent un ordre de grandeur.
  const mid = (a, b) => (a > 0 && b > 0 ? Math.sqrt(a * b) : (a + b) / 2);

  const midLatency = (low.latencyS + high.latencyS) / 2;
  const midGpu = (low.gpuCount + high.gpuCount) / 2;
  const midEnergy = mid(eMin, eMax);

  return {
    gramsCO2e: { min: gMin, max: gMax, mid: mid(gMin, gMax) },
    energyWh: { min: eMin, max: eMax, mid: midEnergy },
    waterL: { min: wMin, max: wMax, mid: mid(wMin, wMax) },
    usageG: (midEnergy / 1000) * gridIntensity,
    embodiedG: embodiedGramsCO2e(midLatency, midGpu),
    gpuCount: high.gpuCount,
    gridIntensity,
    gridKey,
    gridLabel,
    confidence: p.confidence,
    infra: { key: model.provider, label: infra.label, hosts: infra.hosts, pue: infra.pue },
  };
}

/**
 * Effondre une fourchette sur son milieu géométrique.
 *
 * Sert exclusivement à l'analyse de sensibilité : pour mesurer ce qu'un levier
 * apporte à lui seul d'incertitude, il faut figer tous les autres. Le milieu
 * géométrique plutôt qu'arithmétique, pour la même raison qu'ailleurs — les
 * bornes couvrent souvent un ordre de grandeur.
 */
const pinRange = (r) => {
  const v = r.min > 0 && r.max > 0 ? Math.sqrt(r.min * r.max) : (r.min + r.max) / 2;
  return { min: v, max: v, mid: v };
};

const PINNED_WEIGHTS = Object.freeze(
  Object.fromEntries(Object.entries(TOKEN_ENERGY_WEIGHTS).map(([k, r]) => [k, pinRange(r)]))
);

const pinnedParams = (params) => ({ ...params, total: pinRange(params.total), active: pinRange(params.active) });

/**
 * Le même total, recalculé sous plusieurs mix électriques.
 *
 * C'est l'hypothèse la plus contestable du calcul — on ne sait pas où tourne
 * l'inférence — et donc celle qu'un livrable doit exposer plutôt que masquer
 * derrière un total unique. Afficher quatre mix côte à côte dit d'un coup
 * d'œil ce que vaut le chiffre principal.
 *
 * @param {Array<{tokens:object, model:object}>} pairs  un couple par modèle
 * @returns {Array<{key,label,intensity,gramsCO2e:{min,mid,max},ratio}>}
 */
function gridSensitivity(pairs, opts = {}) {
  const rows = GRID_SENSITIVITY.map((key) => {
    const g = GRID_INTENSITY[key];
    const total = sum(pairs.map(({ tokens, model }) => estimate(tokens, model, { ...opts, gridKey: key, gridIntensity: null })));
    return { key, label: g.label, intensity: g.value, gramsCO2e: total.gramsCO2e };
  });
  // Rapporté au mix retenu par ailleurs : « ce serait 4 fois moins en France »
  // se lit mieux qu'une colonne de grammes.
  const reference = sum(pairs.map(({ tokens, model }) => estimate(tokens, model, opts))).gramsCO2e.mid;
  for (const r of rows) r.ratio = reference > 0 ? r.gramsCO2e.mid / reference : null;
  return rows;
}

/**
 * D'où vient l'incertitude : contribution de chaque levier, isolément.
 *
 * On rejoue le calcul en ne laissant varier QU'UN levier à la fois, tous les
 * autres figés sur leur milieu. Le rapport borne haute / borne basse obtenu
 * mesure alors ce que ce levier apporte à lui seul. Sans cette décomposition,
 * une fourchette large se lit comme un aveu d'imprécision générale, alors
 * qu'en pratique un seul terme domine — et c'est celui-là qu'il faut aller
 * corriger, ou défendre devant un vérificateur.
 *
 * Ce n'est pas une propagation d'incertitude au sens statistique : les bornes
 * ne sont pas des intervalles de confiance, et les leviers ne se composent pas
 * linéairement. C'est une analyse de sensibilité, et elle se lit comme telle.
 *
 * @returns {Array<{key,label,ratio,note}>} trié du levier le plus lourd au plus léger
 */
function uncertainty(pairs, opts = {}) {
  const totalMid = (o) => sum(pairs.map(({ tokens, model }) => estimate(tokens, model, o))).gramsCO2e;

  const allPinned = (extra) => ({
    ...opts,
    weights: PINNED_WEIGHTS,
    ...extra,
  });

  // Taille des modèles : seuls les paramètres varient.
  const size = totalMid(allPinned({}));

  // Pondération des classes de token : seuls les poids varient.
  const weights = sum(
    pairs.map(({ tokens, model }) => estimate(tokens, model, { ...opts, params: pinnedParams(model.params) }))
  ).gramsCO2e;

  // Infrastructure : seul le PUE varie, entre les bornes du fournisseur.
  const infraLow = sum(pairs.map(({ tokens, model }) =>
    estimate(tokens, model, allPinned({ params: pinnedParams(model.params), pue: (PROVIDER_INFRA[model.provider] || PROVIDER_INFRA.unknown).pue.min })))).gramsCO2e.mid;
  const infraHigh = sum(pairs.map(({ tokens, model }) =>
    estimate(tokens, model, allPinned({ params: pinnedParams(model.params), pue: (PROVIDER_INFRA[model.provider] || PROVIDER_INFRA.unknown).pue.max })))).gramsCO2e.mid;

  // Mix électrique : amplitude sur les mix de l'analyse de sensibilité.
  const gridMids = GRID_SENSITIVITY.map((key) => sum(pairs.map(({ tokens, model }) =>
    estimate(tokens, model, allPinned({ params: pinnedParams(model.params), gridKey: key, gridIntensity: null })))).gramsCO2e.mid);

  const spread = (min, max) => (min > 0 ? max / min : null);

  const levers = [
    { key: 'model', label: 'Taille des modèles', ratio: spread(size.min, size.max),
      note: "Nombre de paramètres totaux et actifs. Aucun fournisseur fermé ne le publie : c'est l'estimation la plus contestable du calcul." },
    { key: 'weights', label: 'Pondération des tokens', ratio: spread(weights.min, weights.max),
      note: "Coût énergétique relatif du prefill et du cache par rapport au décodage. Dérivation interne TRACE, hors périmètre EcoLogits." },
    { key: 'grid', label: 'Mix électrique', ratio: spread(Math.min(...gridMids), Math.max(...gridMids)),
      note: "Amplitude entre la France et la moyenne mondiale. Ce n'est pas une incertitude de mesure mais une hypothèse de localisation." },
    { key: 'infra', label: 'Infrastructure (PUE)', ratio: spread(infraLow, infraHigh),
      note: "Rendement du centre de données, entre les bornes annoncées par les exploitants possibles du fournisseur." },
  ];

  return levers.filter((l) => l.ratio != null).sort((a, b) => b.ratio - a.ratio);
}

/** Somme de plusieurs estimations (les fourchettes s'additionnent bornes à bornes). */
function sum(estimates) {
  const acc = {
    gramsCO2e: { min: 0, max: 0, mid: 0 },
    energyWh: { min: 0, max: 0, mid: 0 },
    waterL: { min: 0, max: 0, mid: 0 },
    usageG: 0,
    embodiedG: 0,
  };
  for (const e of estimates) {
    if (!e) continue;
    acc.gramsCO2e.min += e.gramsCO2e.min;
    acc.gramsCO2e.max += e.gramsCO2e.max;
    acc.gramsCO2e.mid += e.gramsCO2e.mid;
    acc.energyWh.min += e.energyWh.min;
    acc.energyWh.max += e.energyWh.max;
    acc.energyWh.mid += e.energyWh.mid;
    if (e.waterL) {
      acc.waterL.min += e.waterL.min;
      acc.waterL.max += e.waterL.max;
      acc.waterL.mid += e.waterL.mid;
    }
    acc.usageG += e.usageG;
    acc.embodiedG += e.embodiedG;
  }
  return acc;
}

/** Traduit des grammes de CO2e en équivalents du quotidien. */
function equivalents(grams) {
  return EQUIVALENTS.map((eq) => ({ ...eq, amount: grams / eq.gPerUnit }));
}

module.exports = {
  estimate,
  sum,
  equivalents,
  gridSensitivity,
  uncertainty,
  PROVIDER_INFRA,
  WATER,
  GRID_INTENSITY,
  GRID_SENSITIVITY,
  TOKEN_ENERGY_WEIGHTS,
  EQUIVALENTS,
  // Provenance : ce que consomme un livrable audité, par opposition aux
  // nombres que consomme le calcul.
  factorTable,
  SOURCES,
  cite,
  unpinnedSources,
};
