'use strict';

const { ECOLOGITS: E, TOKEN_ENERGY_WEIGHTS, GRID_INTENSITY, DEFAULT_GRID, EQUIVALENTS } = require('./factors');

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
  const energyWh = pue * (gpuEnergyWh + serverEnergyWh);

  return { energyWh, latencyS, gpuCount };
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
 * @param {object} [opts]  {gridKey, gridIntensity, pue, weights}
 * @returns {{gramsCO2e:{min,max,mid}, energyWh:{min,max,mid}, usageG, embodiedG, gpuCount, gridIntensity, gridLabel, confidence}}
 */
function estimate(tokens, model, opts = {}) {
  const t = {
    input: tokens.input || 0,
    output: tokens.output || 0,
    cacheWrite: tokens.cacheWrite || 0,
    cacheRead: tokens.cacheRead || 0,
  };

  const isLocal = model.provider === 'local';

  // Un modèle local tourne sur la machine de l'utilisateur : pas de datacenter
  // (PUE ~ 1), un seul GPU grand public, et le mix électrique du domicile.
  const pue = opts.pue != null ? opts.pue : isLocal ? 1.05 : E.DATACENTER_PUE;
  const gpuMemoryGb = isLocal ? 24 : E.GPU_MEMORY_GB;

  const gridKey = opts.gridKey || (isLocal ? DEFAULT_GRID.local : DEFAULT_GRID.cloud);
  const gridIntensity =
    opts.gridIntensity != null
      ? opts.gridIntensity
      : (GRID_INTENSITY[gridKey] || GRID_INTENSITY[DEFAULT_GRID.cloud]).value;
  const gridLabel = (GRID_INTENSITY[gridKey] || {}).label || 'Personnalisé';

  const w = opts.weights || TOKEN_ENERGY_WEIGHTS;
  const lowWeights = { output: w.output.min, input: w.input.min, cacheWrite: w.cacheWrite.min, cacheRead: w.cacheRead.min };
  const highWeights = { output: w.output.max, input: w.input.max, cacheWrite: w.cacheWrite.max, cacheRead: w.cacheRead.max };

  const p = model.params;
  const low = computeBound({ tokens: t, totalParamsB: p.total.min, activeParamsB: p.active.min, weights: lowWeights, pue, gpuMemoryGb });
  const high = computeBound({ tokens: t, totalParamsB: p.total.max, activeParamsB: p.active.max, weights: highWeights, pue, gpuMemoryGb });

  const toGrams = (b) => (b.energyWh / 1000) * gridIntensity + embodiedGramsCO2e(b.latencyS, b.gpuCount);

  const gMin = toGrams(low);
  const gMax = toGrams(high);
  const eMin = low.energyWh;
  const eMax = high.energyWh;

  // Point médian : moyenne géométrique, plus fidèle qu'une moyenne
  // arithmétique quand les bornes couvrent un ordre de grandeur.
  const mid = (a, b) => (a > 0 && b > 0 ? Math.sqrt(a * b) : (a + b) / 2);

  const midLatency = (low.latencyS + high.latencyS) / 2;
  const midGpu = (low.gpuCount + high.gpuCount) / 2;
  const midEnergy = mid(eMin, eMax);

  return {
    gramsCO2e: { min: gMin, max: gMax, mid: mid(gMin, gMax) },
    energyWh: { min: eMin, max: eMax, mid: midEnergy },
    usageG: (midEnergy / 1000) * gridIntensity,
    embodiedG: embodiedGramsCO2e(midLatency, midGpu),
    gpuCount: high.gpuCount,
    gridIntensity,
    gridKey,
    gridLabel,
    confidence: p.confidence,
  };
}

/** Somme de plusieurs estimations (les fourchettes s'additionnent bornes à bornes). */
function sum(estimates) {
  const acc = {
    gramsCO2e: { min: 0, max: 0, mid: 0 },
    energyWh: { min: 0, max: 0, mid: 0 },
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
    acc.usageG += e.usageG;
    acc.embodiedG += e.embodiedG;
  }
  return acc;
}

/** Traduit des grammes de CO2e en équivalents du quotidien. */
function equivalents(grams) {
  return EQUIVALENTS.map((eq) => ({ ...eq, amount: grams / eq.gPerUnit }));
}

module.exports = { estimate, sum, equivalents, GRID_INTENSITY, TOKEN_ENERGY_WEIGHTS, EQUIVALENTS };
