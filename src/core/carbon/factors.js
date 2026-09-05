'use strict';

const { t } = require('../../i18n');

const { source, cite } = require('./sources');

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
 *
 * Chaque constante est rattachée à une source dans ECOLOGITS_PROVENANCE :
 * le calcul consomme les nombres, le livrable consomme les citations, et le
 * test `facteurs : toute constante est sourcée` interdit d'ajouter l'un sans
 * l'autre.
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
});

/**
 * Provenance, constante par constante. Les clés couvrent exactement celles de
 * ECOLOGITS — c'est vérifié par test.
 */
const ECOLOGITS_PROVENANCE = Object.freeze({
  MODEL_QUANTIZATION_BITS: { source: 'ecologits', unit: 'bits',
    note: "Hypothèse de service en production. Aucun fournisseur fermé ne publie sa quantification ; elle ne joue que sur le nombre de GPU nécessaires, donc sur la part serveur et la fabrication." },
  GPU_ENERGY_ALPHA: { source: 'ecologits', unit: 'Wh/token/Md-paramètres',
    note: 'Régression EcoLogits sur modèles ouverts, extrapolée aux modèles fermés.' },
  GPU_ENERGY_BETA: { source: 'ecologits', unit: 'Wh/token' },
  GPU_LATENCY_ALPHA: { source: 'ecologits', unit: 's/token/Md-paramètres' },
  GPU_LATENCY_BETA: { source: 'ecologits', unit: 's/token' },
  GPU_MEMORY_GB: { source: 'ecologits', unit: 'Go',
    note: 'Serveur de référence A100 80 Go. Le matériel réellement employé par les fournisseurs est plus récent (H100/H200, TPU) et vraisemblablement plus efficace : le calcul est donc plutôt conservateur.' },
  SERVER_GPU_COUNT: { source: 'ecologits', unit: 'GPU' },
  SERVER_POWER_W: { source: 'ecologits', unit: 'W', note: 'Hors GPU.' },
  GPU_EMBODIED_GWP_KG: { source: 'boavizta', unit: 'kgCO2e/GPU' },
  SERVER_EMBODIED_GWP_KG: { source: 'boavizta', unit: 'kgCO2e/serveur', note: 'Hors GPU.' },
  HARDWARE_LIFESPAN_S: { source: 'boavizta', unit: 's',
    note: "Amortissement sur 5 ans. Une durée de vie réelle plus courte en centre de données majorerait la part de fabrication." },
});
// Le PUE générique de 1,2 d'EcoLogits a été retiré : il ne servait plus depuis
// que chaque fournisseur porte sa propre fourchette dans PROVIDER_INFRA, et le
// laisser dans l'annexe aurait fait citer un facteur que le calcul n'emploie
// pas — la faute exacte qu'un vérificateur relève en premier.

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

/** Provenance des pondérations. Une seule source : la dérivation ci-dessus. */
const TOKEN_ENERGY_PROVENANCE = Object.freeze({
  output: { source: 'traceDerived', note: 'Référence, 1.0 par définition.' },
  input: { source: 'traceDerived', note: 'Bilan de FLOPs du prefill, MFU 40 % (borne basse) à MFU faible (borne haute).' },
  cacheWrite: { source: 'traceDerived', note: 'Prefill + persistance du KV.' },
  cacheRead: { source: 'traceDerived', note: 'Lecture mémoire et attention seules ; projections et FFN économisés.' },
});

/**
 * Infrastructure par fournisseur.
 *
 * EcoLogits applique un PUE unique de 1,2 à tout le monde. C'est une moyenne
 * commode, mais elle efface un écart réel : les hyperscalers annoncent 1,09 à
 * 1,20 en moyenne de flotte, quand un centre de données de colocation
 * ordinaire est plutôt à 1,5. Comme on sait, pour chaque modèle, chez qui il
 * tourne, autant s'en servir.
 *
 * Trois réserves, à porter dans tout livrable :
 *  1. Ce sont des moyennes annuelles MONDIALES de flotte. Le site précis qui
 *     sert une requête n'est pas connu, et un site chaud est bien au-dessus.
 *  2. Ce sont des chiffres DÉCLARÉS par les exploitants, non audités.
 *  3. Le rattachement d'un fournisseur de modèle à un exploitant de cloud est
 *     public dans les grandes lignes, mais pas la répartition entre eux.
 *
 * D'où des FOURCHETTES, jamais un point : elles couvrent l'écart entre
 * exploitants possibles, et se propagent dans la fourchette finale au lieu de
 * disparaître dans une moyenne.
 *
 * `wueL` est l'eau consommée SUR le site (refroidissement), en litres par kWh
 * informatique. L'eau consommée hors site pour produire l'électricité est
 * traitée à part, dans WATER, parce qu'elle dépend du mix électrique.
 */
const PROVIDER_INFRA = Object.freeze({
  anthropic: Object.freeze({
    label: 'Anthropic',
    hosts: 'Amazon Web Services, Google Cloud',
    pue: { min: 1.09, max: 1.2 },
    wueL: { min: 0.18, max: 1.1 },
    gridKey: 'us-average',
    source: 'providerInfra',
    basis:
      "Anthropic sert ses modèles depuis AWS (Trainium) et Google Cloud. La " +
      "fourchette couvre les moyennes de flotte annoncées par ces deux " +
      "exploitants, sans savoir laquelle sert une requête donnée.",
  }),
  openai: Object.freeze({
    label: 'OpenAI',
    hosts: 'Microsoft Azure',
    pue: { min: 1.12, max: 1.25 },
    wueL: { min: 0.3, max: 0.5 },
    gridKey: 'us-average',
    source: 'providerInfra',
    basis:
      "OpenAI sert ses modèles depuis Azure. La fourchette couvre la moyenne " +
      "de flotte annoncée par Microsoft et la dispersion entre régions, la " +
      "région servant une requête donnée n'étant pas connue.",
  }),
  local: Object.freeze({
    get label() { return t('infra.local'); },
    hosts: "poste de l'utilisateur",
    pue: { min: 1.0, max: 1.1 },
    wueL: { min: 0, max: 0 },
    gridKey: 'france',
    gpuMemoryGb: 24,
    source: 'traceDerived',
    basis:
      "Pas de centre de données : ni refroidissement mécanique dédié (PUE ~ 1) " +
      "ni consommation d'eau. Un seul GPU grand public de 24 Go, et le mix " +
      "électrique du domicile et non celui du fournisseur.",
  }),
  unknown: Object.freeze({
    get label() { return t('infra.unknown'); },
    hosts: 'inconnu',
    pue: { min: 1.2, max: 1.6 },
    wueL: { min: 0.2, max: 1.8 },
    gridKey: 'world',
    source: 'providerInfra',
    basis:
      "Aucun rattachement connu : la fourchette s'ouvre du meilleur " +
      "hyperscaler à un centre de données de colocation ordinaire (PUE ~ 1,5), " +
      "et le mix électrique retenu est la moyenne mondiale plutôt qu'une " +
      "hypothèse de localisation flatteuse.",
  }),
});

/**
 * Empreinte eau.
 *
 * L'eau HORS site — celle qu'il a fallu pour produire l'électricité consommée
 * — domine généralement l'eau de refroidissement. Elle dépend du mix : un
 * réseau nucléaire ou thermique en consomme beaucoup, un réseau éolien ou
 * solaire presque rien. TRACE ne dispose pas d'un facteur eau par pays ; on
 * retient une fourchette couvrant les mix courants, ce qui est grossier mais
 * honnête tant que la fourchette est affichée comme telle.
 */
const WATER = Object.freeze({
  OFFSITE_L_PER_KWH: { min: 1.2, max: 3.1 },
});

const WATER_PROVENANCE = Object.freeze({
  OFFSITE_L_PER_KWH: { source: 'waterFootprint', unit: 'L/kWh',
    note: "Eau consommée pour produire l'électricité, hors site. Fourchette couvrant les mix électriques courants, faute d'un facteur par pays." },
});

/**
 * Intensité carbone du réseau électrique, en gCO2eq/kWh.
 *
 * Toutes ces valeurs sont des facteurs de LOCALISATION (location-based, au
 * sens du GHG Protocol) : l'intensité physique du réseau qui alimente le site.
 * Elles ignorent délibérément les garanties d'origine et PPA achetés par les
 * exploitants de centres de données, qui feraient s'effondrer le chiffre en
 * approche market-based. Un bilan complet déclare les deux ; TRACE ne peut
 * calculer que le premier, faute de publication des fournisseurs, et c'est
 * aussi le plus conservateur — donc le défendable.
 */
const GRID_INTENSITY = Object.freeze({
  france: { get label() { return t('grid.france'); }, value: 56, source: 'ademe', basis: 'location-based' },
  sweden: { get label() { return t('grid.sweden'); }, value: 40, source: 'ember', basis: 'location-based' },
  canada: { get label() { return t('grid.canada'); }, value: 120, source: 'ember', basis: 'location-based' },
  uk: { get label() { return t('grid.uk'); }, value: 210, source: 'ember', basis: 'location-based' },
  'eu-27': { get label() { return t('grid.eu-27'); }, value: 250, source: 'ember', basis: 'location-based' },
  'us-west': { get label() { return t('grid.us-west'); }, value: 240, source: 'epaEgrid', basis: 'location-based' },
  'us-east': { get label() { return t('grid.us-east'); }, value: 320, source: 'epaEgrid', basis: 'location-based' },
  'us-average': { get label() { return t('grid.us-average'); }, value: 369, source: 'epaEgrid', basis: 'location-based' },
  germany: { get label() { return t('grid.germany'); }, value: 380, source: 'ember', basis: 'location-based' },
  world: { get label() { return t('grid.world'); }, value: 480, source: 'ember', basis: 'location-based' },
  asia: { get label() { return t('grid.asia'); }, value: 540, source: 'ember', basis: 'location-based' },
});

/**
 * Filet de sécurité, si un fournisseur n'a pas d'entrée dans PROVIDER_INFRA.
 * En régime normal c'est cette table-là qui décide de la localisation, chaque
 * fournisseur portant la sienne.
 *
 * L'hypothèse reste le levier le plus sensible du calcul : le rapport entre le
 * mix français et le mix asiatique est de près de dix. Tout livrable doit
 * porter une analyse de sensibilité sur ce paramètre plutôt que de présenter
 * un total unique — c'est ce que fait `gridSensitivity`.
 */
const DEFAULT_GRID = Object.freeze({
  cloud: 'us-average',
  local: 'france',
});

/** Les bornes d'une analyse de sensibilité au mix électrique. */
const GRID_SENSITIVITY = Object.freeze(['france', 'eu-27', 'us-average', 'world']);

/**
 * Équivalents parlants, en gCO2eq par unité.
 *
 * Chacun porte sa propre réserve : un équivalent sert à donner une intuition,
 * pas à établir une comparaison rigoureuse. Le périmètre de chaque facteur
 * (usage seul ou cycle de vie, France ou monde) diffère de celui du calcul
 * carbone, et le dire à la ligne évite qu'un lecteur les additionne.
 */
const EQUIVALENTS = Object.freeze([
  { key: 'car', get label() { return t('equiv.car'); }, unit: 'km', gPerUnit: 120, icon: '🚗', source: 'ademe',
    note: 'Voiture particulière moyenne, usage seul (hors fabrication du véhicule).' },
  { key: 'streaming', get label() { return t('equiv.streaming'); }, unit: 'h', gPerUnit: 36, icon: '📺', source: 'ademe',
    note: 'Ordre de grandeur très dépendant du terminal, de la définition et du réseau.' },
  { key: 'phone', get label() { return t('equiv.phone'); }, unit: '', gPerUnit: 8, icon: '🔋', source: 'ademe',
    note: 'Une charge complète sur le mix français, hors fabrication de l’appareil.' },
  { key: 'tgv', get label() { return t('equiv.tgv'); }, unit: 'km', gPerUnit: 2.3, icon: '🚆', source: 'ademe',
    note: 'Par voyageur-kilomètre, sur le mix électrique français.' },
  { key: 'beef', get label() { return t('equiv.beef'); }, unit: 'g', gPerUnit: 27, icon: '🥩', source: 'ademe',
    note: 'Viande bovine, du champ à l’assiette. Périmètre cycle de vie, contrairement aux autres équivalents.' },
]);

/**
 * Tableau des facteurs employés, prêt à être annexé à un rapport : une ligne
 * par constante, avec sa valeur, son unité et sa citation.
 *
 * @param {object} [opts] {gridKey} pour ne citer que le mix effectivement retenu
 * @returns {Array<{group,key,value,unit,source,citation,pinned,note}>}
 */
function factorTable(opts = {}) {
  const rows = [];
  const push = (group, key, value, unit, sourceId, note) => {
    const s = source(sourceId);
    rows.push({ group, key, value, unit, source: sourceId, citation: cite(sourceId), pinned: s.pinned, note: note || s.note || null });
  };

  for (const [key, value] of Object.entries(ECOLOGITS)) {
    const p = ECOLOGITS_PROVENANCE[key];
    push('Méthode d’inférence', key, value, p.unit, p.source, p.note);
  }

  for (const [key, w] of Object.entries(TOKEN_ENERGY_WEIGHTS)) {
    const p = TOKEN_ENERGY_PROVENANCE[key];
    push('Pondération par classe de token', key, `${w.min} – ${w.max}`, 'équivalent-token de sortie', p.source, p.note);
  }

  const gridKeys = opts.gridKey ? [opts.gridKey] : Object.keys(GRID_INTENSITY);
  for (const key of gridKeys) {
    const g = GRID_INTENSITY[key];
    if (!g) continue;
    push('Mix électrique', g.label, g.value, 'gCO2e/kWh', g.source, `Approche ${g.basis}.`);
  }

  for (const [key, infra] of Object.entries(PROVIDER_INFRA)) {
    push('Infrastructure du fournisseur', `${infra.label} — PUE`, `${infra.pue.min} – ${infra.pue.max}`,
      'sans dimension', infra.source, infra.basis);
    push('Infrastructure du fournisseur', `${infra.label} — eau sur site`, `${infra.wueL.min} – ${infra.wueL.max}`,
      'L/kWh', infra.wueL.max > 0 ? 'waterFootprint' : infra.source,
      `Hébergement : ${infra.hosts}.`);
    if (opts.gridKey) continue; // le mix retenu est déjà cité plus haut
    push('Infrastructure du fournisseur', `${infra.label} — mix par défaut`,
      (GRID_INTENSITY[infra.gridKey] || {}).label || infra.gridKey, 'zone', infra.source,
      `Hypothèse de localisation pour ${key}.`);
  }

  for (const [key, w] of Object.entries(WATER)) {
    const p = WATER_PROVENANCE[key];
    push('Empreinte eau', key, `${w.min} – ${w.max}`, p.unit, p.source, p.note);
  }

  for (const eq of EQUIVALENTS) {
    push('Équivalent de communication', eq.label, eq.gPerUnit, 'gCO2e/unité', eq.source, eq.note);
  }

  return rows;
}

module.exports = {
  ECOLOGITS,
  PROVIDER_INFRA,
  WATER,
  WATER_PROVENANCE,
  ECOLOGITS_PROVENANCE,
  TOKEN_ENERGY_WEIGHTS,
  TOKEN_ENERGY_PROVENANCE,
  GRID_INTENSITY,
  DEFAULT_GRID,
  GRID_SENSITIVITY,
  EQUIVALENTS,
  factorTable,
};
