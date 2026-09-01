'use strict';

/**
 * Constantes de la méthodologie EcoLogits / Boavizta pour l'inférence LLM.
 *
 * Référence : https://ecologits.ai/latest/methodology/llm_inference/
 * Le modèle physique sous-jacent : l'énergie de génération d'un token est
 * approximée linéairement en fonction du nombre de paramètres ACTIFS du
 * modèle (ce qui rend le calcul valable aussi bien pour un modèle dense que
 * pour un mixture-of-experts), le tout mesuré sur un serveur de référence à
 * 8 GPU A100 80 Go.
 *
 * Ne pas retoucher ces valeurs à la légère : ce sont elles qui rendent le
 * chiffre affiché citable. Les paramètres réglables par l'utilisateur (mix
 * électrique, PUE, ratio prefill) vivent ailleurs, dans la config.
 */
const ECOLOGITS = Object.freeze({
  // Quantification supposée des poids en production (4 bits).
  MODEL_QUANTIZATION_BITS: 4,

  // Énergie GPU par token généré : alpha * paramètres_actifs(Md) + beta  [Wh]
  GPU_ENERGY_ALPHA: 8.91e-5,
  GPU_ENERGY_BETA: 1.43e-3,

  // Latence GPU par token généré : alpha * paramètres_actifs(Md) + beta  [s]
  GPU_LATENCY_ALPHA: 8.02e-4,
  GPU_LATENCY_BETA: 2.23e-2,

  GPU_MEMORY_GB: 80, // A100 80 Go de référence
  SERVER_GPU_COUNT: 8,
  SERVER_POWER_W: 1000, // consommation du serveur HORS GPU

  // Impacts « embarqués » (fabrication), amortis sur la durée de vie.
  GPU_EMBODIED_GWP_KG: 143,
  SERVER_EMBODIED_GWP_KG: 3000,
  HARDWARE_LIFESPAN_S: 5 * 365 * 24 * 3600, // 5 ans

  DATACENTER_PUE: 1.2,
});

/**
 * Extension TRACE (hors périmètre EcoLogits, assumée comme telle).
 *
 * EcoLogits ne compte QUE les tokens de sortie. Pour un usage type Claude Code
 * c'est intenable : on observe couramment 300 M de tokens de cache lus pour
 * 500 k tokens générés. Ignorer l'entrée sous-estimerait l'empreinte d'un
 * facteur ~100 sur ce profil d'usage.
 *
 * On pondère donc chaque classe de token par son coût énergétique relatif à un
 * token de sortie :
 *
 *  - Sortie (décodage) = 1.0 par définition. Chaque token impose de relire
 *    tous les poids actifs : c'est borné par la bande passante mémoire, donc
 *    très coûteux par token.
 *  - Entrée (prefill) : même volume de calcul par token, mais traité en un
 *    seul batch à forte intensité arithmétique, donc bien mieux amorti sur le
 *    matériel. L'ordre de grandeur admis est 1 à 2 ordres de grandeur moins
 *    cher par token.
 *  - Lecture de cache : le KV est déjà calculé. Il reste la lecture mémoire et
 *    l'attention sur ces positions, mais tout le calcul des projections et du
 *    FFN est économisé — d'où un coût résiduel.
 *  - Écriture de cache : un prefill classique, plus la persistance du KV.
 *
 * Calage du ratio prefill, sur un bilan de FLOPs plutôt qu'à l'intuition :
 * un prefill de 37 k tokens sur un modèle à 100 Md de paramètres actifs coûte
 * 2 x 100e9 x 37e3 = 7,4e15 FLOPs ; sur 8 A100 à 40 % de MFU (1e15 FLOP/s)
 * cela fait 7,4 s, soit 6,6 Wh à 3,2 kW. Rapporté au token : 1,8e-4 Wh, contre
 * 1,03e-2 Wh pour un token décodé sur le même modèle. Ratio ~ 0,017. La borne
 * haute couvre les régimes à faible MFU (petits batches, contextes courts).
 *
 * Ces ratios sont des estimations d'ingénierie, pas des mesures. Ils sont
 * réglables dans les préférences, et l'écart min/max se propage dans la
 * fourchette affichée.
 */
const TOKEN_ENERGY_WEIGHTS = Object.freeze({
  output: { min: 1.0, max: 1.0 },
  input: { min: 0.012, max: 0.06 },
  cacheWrite: { min: 0.014, max: 0.07 },
  cacheRead: { min: 0.0006, max: 0.005 },
});

/**
 * Intensité carbone du réseau électrique, en gCO2eq/kWh.
 * Sources : ADEME (France), AIE / Ember (moyennes régionales).
 */
const GRID_INTENSITY = Object.freeze({
  france: { label: 'France', value: 56 },
  sweden: { label: 'Suède / Nordique', value: 40 },
  canada: { label: 'Canada', value: 120 },
  uk: { label: 'Royaume-Uni', value: 210 },
  'eu-27': { label: 'Union européenne', value: 250 },
  'us-west': { label: 'États-Unis (Ouest)', value: 240 },
  'us-east': { label: 'États-Unis (Est / Virginie)', value: 320 },
  'us-average': { label: 'États-Unis (moyenne)', value: 369 },
  germany: { label: 'Allemagne', value: 380 },
  world: { label: 'Moyenne mondiale', value: 480 },
  asia: { label: 'Asie-Pacifique', value: 540 },
});

/**
 * Par défaut, l'inférence des fournisseurs cloud est supposée tourner aux
 * États-Unis (c'est là que se trouve l'essentiel de la capacité). Un modèle
 * exécuté en local tourne, lui, sur le réseau électrique de l'utilisateur.
 */
const DEFAULT_GRID = Object.freeze({
  cloud: 'us-average',
  local: 'france',
});

/** Équivalents parlants, en gCO2eq par unité. */
const EQUIVALENTS = Object.freeze([
  { key: 'car', label: 'km en voiture', unit: 'km', gPerUnit: 120, icon: '🚗' },
  { key: 'streaming', label: 'h de streaming vidéo', unit: 'h', gPerUnit: 36, icon: '📺' },
  { key: 'phone', label: 'charges de smartphone', unit: '', gPerUnit: 8, icon: '🔋' },
  { key: 'tgv', label: 'km en TGV', unit: 'km', gPerUnit: 2.3, icon: '🚆' },
  { key: 'beef', label: 'g de bœuf', unit: 'g', gPerUnit: 27, icon: '🥩' },
]);

module.exports = { ECOLOGITS, TOKEN_ENERGY_WEIGHTS, GRID_INTENSITY, DEFAULT_GRID, EQUIVALENTS };
