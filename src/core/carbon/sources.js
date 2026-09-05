'use strict';

/**
 * Registre des sources des facteurs d'émission et des constantes de méthode.
 *
 * Raison d'être : un chiffre carbone n'est opposable que si l'on peut remonter
 * chaque facteur à une publication identifiée, dans une version datée. « 56 g
 * par kWh » n'est pas une donnée — « 56 gCO2e/kWh, Base Carbone ADEME v23.4,
 * mix de consommation France, consultée le 12/03/2026 » en est une. Le premier
 * chiffre se discute, le second se vérifie.
 *
 * D'où le champ `pinned` : il vaut `false` tant que la version exacte et la
 * date de consultation n'ont pas été relevées SUR la publication. Une source
 * non figée reste utilisable dans l'application — l'ordre de grandeur est bon
 * — mais elle ne peut pas partir dans un livrable audité. `unpinnedSources()`
 * en donne la liste, et un test la garde visible plutôt que de la laisser
 * s'oublier.
 *
 * Ne jamais inventer un numéro de version pour faire propre : une fausse
 * précision de citation est pire qu'une citation absente, parce qu'elle passe
 * la relecture.
 */

/**
 * @typedef {object} Source
 * @property {string} label       titre de la publication
 * @property {string} publisher   organisme émetteur
 * @property {string} url         référence stable
 * @property {?string} version    version ou millésime du jeu de données
 * @property {?string} consultedOn date de consultation, ISO 8601
 * @property {boolean} pinned     version ET date relevées sur la publication
 * @property {string} [note]      réserve d'usage, reprise dans le livrable
 */

const SOURCES = Object.freeze({
  ecologits: Object.freeze({
    label: "Méthodologie d'inférence LLM",
    publisher: 'EcoLogits (GenAI Impact)',
    url: 'https://ecologits.ai/latest/methodology/llm_inference/',
    version: null,
    consultedOn: null,
    pinned: false,
    note:
      "L'URL pointe `latest` : elle suit les révisions de la méthode. À " +
      'remplacer par une URL versionnée avant tout usage en livrable, sans ' +
      'quoi le calcul ne serait pas reproductible.',
  }),

  boavizta: Object.freeze({
    label: 'Facteurs d’impact de fabrication des serveurs et GPU',
    publisher: 'Boavizta',
    url: 'https://boavizta.org/',
    version: null,
    consultedOn: null,
    pinned: false,
    note:
      'Repris par EcoLogits pour les impacts embarqués. Les valeurs retenues ' +
      "correspondent à un serveur 8 GPU A100 80 Go ; elles n'ont pas été " +
      'reprises à la source Boavizta elle-même.',
  }),

  ademe: Object.freeze({
    label: 'Base Carbone',
    publisher: 'ADEME',
    url: 'https://base-empreinte.ademe.fr/',
    version: null,
    consultedOn: null,
    pinned: false,
    note:
      'Mix de CONSOMMATION (et non de production) pour la France : c’est ' +
      "celui qu'attend un bilan d'entreprise, il intègre les imports.",
  }),

  epaEgrid: Object.freeze({
    label: 'eGRID — Emissions & Generation Resource Integrated Database',
    publisher: 'U.S. Environmental Protection Agency',
    url: 'https://www.epa.gov/egrid',
    version: null,
    consultedOn: null,
    pinned: false,
    note:
      "Moyenne nationale et sous-régions états-uniennes. Facteur de LOCALISATION " +
      '(location-based) : il ignore les garanties d’origine achetées par les ' +
      'exploitants de centres de données. Voir la note `location-based` du livrable.',
  }),

  ember: Object.freeze({
    label: 'Global Electricity Review / Yearly Electricity Data',
    publisher: 'Ember',
    url: 'https://ember-energy.org/data/yearly-electricity-data/',
    version: null,
    consultedOn: null,
    pinned: false,
    note: 'Intensités moyennes mondiales et par zone.',
  }),

  traceDerived: Object.freeze({
    label: 'Dérivation interne TRACE (bilan de FLOPs)',
    publisher: 'TRACE',
    url: 'src/core/carbon/factors.js',
    version: '0.1.0',
    consultedOn: null,
    pinned: true,
    note:
      "Estimation d'ingénierie, PAS une mesure. Hors périmètre EcoLogits, " +
      'assumée comme extension. Le raisonnement complet est en commentaire au ' +
      'point de définition, et les bornes min/max se propagent dans la fourchette.',
  }),

  providerInfra: Object.freeze({
    label: 'Rapports environnementaux des exploitants de centres de données',
    publisher: 'Amazon Web Services, Google, Microsoft',
    url: 'https://sustainability.aboutamazon.com/',
    version: null,
    consultedOn: null,
    pinned: false,
    note:
      'PUE et WUE annoncés par les exploitants, en moyenne de flotte et non ' +
      "par site. Deux réserves : ce sont des moyennes annuelles mondiales, " +
      "alors que le site qui sert l'inférence est inconnu ; et ce sont des " +
      'chiffres déclarés, non audités par un tiers. Les fourchettes retenues ' +
      'couvrent l’écart entre exploitants plutôt que de retenir le meilleur.',
  }),

  waterFootprint: Object.freeze({
    label: 'Making AI Less Thirsty — empreinte eau de l’inférence',
    publisher: 'Li et al. (UC Riverside / UT Arlington), arXiv:2304.03271',
    url: 'https://arxiv.org/abs/2304.03271',
    version: null,
    consultedOn: null,
    pinned: false,
    note:
      'Distingue l’eau consommée SUR le site (refroidissement) de l’eau ' +
      'consommée HORS site pour produire l’électricité. La seconde domine ' +
      'largement, et dépend du mix électrique — donc de la même hypothèse de ' +
      'localisation que le carbone.',
  }),

  providerPricing: Object.freeze({
    label: 'Grilles tarifaires publiques des fournisseurs',
    publisher: 'Anthropic, OpenAI',
    url: 'https://www.anthropic.com/pricing',
    version: null,
    consultedOn: null,
    pinned: false,
    note: 'Factuel, mais volatil : à revérifier à chaque édition du livrable.',
  }),

  inferredFromBehaviour: Object.freeze({
    label: 'Estimation TRACE par analogie (aucune publication du fournisseur)',
    publisher: 'TRACE',
    url: 'src/core/models.js',
    version: '0.1.0',
    consultedOn: null,
    pinned: true,
    note:
      "Les fournisseurs de modèles fermés ne publient pas leur nombre de " +
      "paramètres. Les fourchettes sont larges à dessein et constituent la " +
      "source d'incertitude DOMINANTE du calcul : c'est le point qu'un " +
      'vérificateur attaquera en premier, et il doit être présenté comme tel.',
  }),
});

/** Résout un identifiant de source. Lève plutôt que de renvoyer un trou. */
function source(id) {
  const s = SOURCES[id];
  if (!s) throw new Error(`Source inconnue : ${id}`);
  return s;
}

/** Citation lisible, pour une note de bas de page. */
function cite(id) {
  const s = source(id);
  const bits = [s.publisher, s.label];
  if (s.version) bits.push(`v${s.version}`);
  if (s.consultedOn) bits.push(`consultée le ${s.consultedOn}`);
  // L'avertissement se déclenche sur `pinned`, pas sur l'absence de date : une
  // dérivation interne est figée par sa version, elle ne se « consulte » pas.
  if (!s.pinned) bits.push('version et date de consultation NON RELEVÉES');
  return bits.join(', ');
}

/**
 * Les sources qu'il reste à figer avant qu'un livrable soit opposable.
 * Un tableau vide est la condition d'entrée dans un rapport audité.
 */
function unpinnedSources() {
  return Object.entries(SOURCES)
    .filter(([, s]) => !s.pinned)
    .map(([id, s]) => ({ id, label: s.label, publisher: s.publisher, url: s.url }));
}

module.exports = { SOURCES, source, cite, unpinnedSources };
