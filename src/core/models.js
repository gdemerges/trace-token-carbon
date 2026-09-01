'use strict';

/**
 * Registre canonique des modèles.
 *
 * Deux familles d'information cohabitent ici, et elles n'ont PAS le même statut
 * épistémique — l'UI doit les distinguer :
 *
 *  - `pricing` : tarifs publics, en USD par million de tokens. Factuel.
 *  - `params`  : nombre de paramètres (total / actifs), en milliards. Pour les
 *    modèles fermés (Anthropic, OpenAI, Google) ces valeurs ne sont PAS
 *    divulguées : ce sont des fourchettes d'estimation, exactement comme le
 *    fait EcoLogits pour les modèles propriétaires. D'où `confidence` et les
 *    bornes min/max, qui se propagent jusqu'à la fourchette carbone affichée.
 *
 * Les tarifs bougent. Tout ce fichier est surchargeable par l'utilisateur via
 * `~/.config/trace/models.override.json` (voir config.js) sans recompiler.
 */

// Multiplicateurs de cache Anthropic (et repris par les autres fournisseurs
// qui facturent le cache) : lecture 0.1x le prix d'entrée, écriture 1.25x en
// TTL 5 minutes et 2x en TTL 1 heure.
const CACHE_MULTIPLIERS = Object.freeze({
  read: 0.1,
  write5m: 1.25,
  write1h: 2.0,
});

/** Fourchette d'estimation. `min === max` => valeur connue avec certitude. */
const range = (min, max) => ({ min, max, mid: (min + max) / 2 });

/**
 * Profils de paramètres par famille. Les modèles fermés sont des estimations
 * assumées ; on garde des fourchettes larges plutôt qu'un faux point précis.
 */
const PARAM_PROFILES = {
  // Les modèles frontière actuels sont, selon toute vraisemblance, des
  // mixture-of-experts : le nombre de paramètres ACTIFS par token est très
  // inférieur au total. C'est ce qui explique leurs vitesses de génération
  // observées (50-100 tokens/s), impossibles à atteindre en dense à cette
  // échelle. Les fourchettes ci-dessous restent larges, à dessein.
  'claude-fable': { total: range(400, 1200), active: range(60, 250), confidence: 'estimated' },
  'claude-opus': { total: range(300, 800), active: range(40, 150), confidence: 'estimated' },
  'claude-sonnet': { total: range(100, 300), active: range(15, 60), confidence: 'estimated' },
  'claude-haiku': { total: range(20, 80), active: range(5, 20), confidence: 'estimated' },
  'gpt-frontier': { total: range(300, 1000), active: range(50, 200), confidence: 'estimated' },
  'gpt-mid': { total: range(100, 400), active: range(20, 80), confidence: 'estimated' },
  'gpt-small': { total: range(8, 50), active: range(3, 20), confidence: 'estimated' },
  'gemini-pro': { total: range(200, 800), active: range(30, 150), confidence: 'estimated' },
  'gemini-flash': { total: range(20, 120), active: range(5, 30), confidence: 'estimated' },
  unknown: { total: range(70, 400), active: range(15, 100), confidence: 'unknown' },
};

/**
 * Le registre. `match` est testé dans l'ordre : les entrées les plus
 * spécifiques doivent précéder les plus générales.
 *
 * `pricing` en USD / million de tokens. `null` => modèle local, coût monétaire
 * nul (mais empreinte carbone bien réelle, portée par votre machine).
 */
const REGISTRY = [
  // ---- Anthropic ----------------------------------------------------------
  { match: /^claude-mythos-5/, id: 'claude-mythos-5', label: 'Claude Mythos 5', provider: 'anthropic', family: 'claude-fable', pricing: { input: 10, output: 50 }, context: 1_000_000 },
  { match: /^claude-fable-5/, id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'anthropic', family: 'claude-fable', pricing: { input: 10, output: 50 }, context: 1_000_000 },
  { match: /^claude-opus-5/, id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', family: 'claude-opus', pricing: { input: 5, output: 25 }, context: 1_000_000 },
  { match: /^claude-opus-4-8/, id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', family: 'claude-opus', pricing: { input: 5, output: 25 }, context: 1_000_000 },
  { match: /^claude-opus-4-7/, id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic', family: 'claude-opus', pricing: { input: 5, output: 25 }, context: 1_000_000 },
  { match: /^claude-opus-4-6/, id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic', family: 'claude-opus', pricing: { input: 5, output: 25 }, context: 1_000_000 },
  { match: /^claude-opus-4-5/, id: 'claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic', family: 'claude-opus', pricing: { input: 5, output: 25 }, context: 200_000 },
  { match: /^claude-opus-4-1/, id: 'claude-opus-4-1', label: 'Claude Opus 4.1', provider: 'anthropic', family: 'claude-opus', pricing: { input: 15, output: 75 }, context: 200_000 },
  { match: /^claude-opus-4/, id: 'claude-opus-4-0', label: 'Claude Opus 4', provider: 'anthropic', family: 'claude-opus', pricing: { input: 15, output: 75 }, context: 200_000 },
  { match: /^claude-(3-)?opus/, id: 'claude-3-opus', label: 'Claude Opus 3', provider: 'anthropic', family: 'claude-opus', pricing: { input: 15, output: 75 }, context: 200_000 },
  { match: /^claude-sonnet-5/, id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', family: 'claude-sonnet', pricing: { input: 2, output: 10 }, context: 1_000_000 },
  { match: /^claude-sonnet-4-6/, id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', family: 'claude-sonnet', pricing: { input: 3, output: 15 }, context: 1_000_000 },
  { match: /^claude-sonnet-4-5/, id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic', family: 'claude-sonnet', pricing: { input: 3, output: 15 }, context: 200_000 },
  { match: /^claude-sonnet-4/, id: 'claude-sonnet-4-0', label: 'Claude Sonnet 4', provider: 'anthropic', family: 'claude-sonnet', pricing: { input: 3, output: 15 }, context: 200_000 },
  { match: /^claude-3-7-sonnet/, id: 'claude-3-7-sonnet', label: 'Claude Sonnet 3.7', provider: 'anthropic', family: 'claude-sonnet', pricing: { input: 3, output: 15 }, context: 200_000 },
  { match: /^claude-3-5-sonnet/, id: 'claude-3-5-sonnet', label: 'Claude Sonnet 3.5', provider: 'anthropic', family: 'claude-sonnet', pricing: { input: 3, output: 15 }, context: 200_000 },
  { match: /^claude-haiku-4-5/, id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', family: 'claude-haiku', pricing: { input: 1, output: 5 }, context: 200_000 },
  { match: /^claude-3-5-haiku/, id: 'claude-3-5-haiku', label: 'Claude Haiku 3.5', provider: 'anthropic', family: 'claude-haiku', pricing: { input: 0.8, output: 4 }, context: 200_000 },
  { match: /^claude-3-haiku/, id: 'claude-3-haiku', label: 'Claude Haiku 3', provider: 'anthropic', family: 'claude-haiku', pricing: { input: 0.25, output: 1.25 }, context: 200_000 },

  // ---- OpenAI -------------------------------------------------------------
  { match: /^gpt-5.*mini/, id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', family: 'gpt-small', pricing: { input: 0.25, output: 2 }, context: 400_000 },
  { match: /^gpt-5/, id: 'gpt-5', label: 'GPT-5', provider: 'openai', family: 'gpt-frontier', pricing: { input: 1.25, output: 10 }, context: 400_000 },
  { match: /^o[34]/, id: 'o3', label: 'OpenAI o3', provider: 'openai', family: 'gpt-frontier', pricing: { input: 2, output: 8 }, context: 200_000 },
  { match: /^gpt-4\.1.*mini/, id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', provider: 'openai', family: 'gpt-small', pricing: { input: 0.4, output: 1.6 }, context: 1_000_000 },
  { match: /^gpt-4\.1/, id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai', family: 'gpt-mid', pricing: { input: 2, output: 8 }, context: 1_000_000 },
  { match: /^gpt-4o.*mini/, id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai', family: 'gpt-small', pricing: { input: 0.15, output: 0.6 }, context: 128_000 },
  { match: /^gpt-4o/, id: 'gpt-4o', label: 'GPT-4o', provider: 'openai', family: 'gpt-mid', pricing: { input: 2.5, output: 10 }, context: 128_000 },
  { match: /^codex/, id: 'codex', label: 'Codex', provider: 'openai', family: 'gpt-frontier', pricing: { input: 1.25, output: 10 }, context: 400_000 },

  // ---- Google -------------------------------------------------------------
  { match: /^gemini-.*flash/, id: 'gemini-flash', label: 'Gemini Flash', provider: 'google', family: 'gemini-flash', pricing: { input: 0.3, output: 2.5 }, context: 1_000_000 },
  { match: /^gemini-.*pro/, id: 'gemini-pro', label: 'Gemini Pro', provider: 'google', family: 'gemini-pro', pricing: { input: 1.25, output: 10 }, context: 1_000_000 },
  { match: /^gemini/, id: 'gemini', label: 'Gemini', provider: 'google', family: 'gemini-pro', pricing: { input: 1.25, output: 10 }, context: 1_000_000 },
];

/**
 * Modèles locaux (Ollama & co) : le nom porte souvent la taille réelle, ce qui
 * est la seule situation où le nombre de paramètres est *connu* plutôt
 * qu'estimé. `llama3.1:70b` -> 70 milliards, confidence 'disclosed'.
 */
function parseLocalModel(raw) {
  const m = /[:\-_](\d+(?:\.\d+)?)\s*b\b/i.exec(raw);
  if (!m) return null;
  const b = parseFloat(m[1]);
  // Un modèle local dense a autant de paramètres actifs que totaux.
  return {
    id: raw,
    label: raw,
    provider: 'local',
    family: 'local',
    pricing: null,
    context: null,
    params: { total: range(b, b), active: range(b, b), confidence: 'disclosed' },
  };
}

const _cache = new Map();

/**
 * Résout n'importe quelle chaîne de modèle vers un enregistrement canonique.
 * Ne renvoie jamais null : un modèle inconnu retombe sur un profil `unknown`
 * explicitement marqué, pour qu'il reste visible dans l'UI plutôt que d'être
 * silencieusement absent des totaux.
 */
function resolveModel(raw, overrides = null) {
  if (!raw || typeof raw !== 'string') raw = 'unknown';
  const key = raw.toLowerCase();
  if (!overrides && _cache.has(key)) return _cache.get(key);

  let record = null;

  if (overrides && overrides[key]) {
    record = { id: key, label: key, provider: 'unknown', family: 'unknown', pricing: null, context: null, ...overrides[key] };
  } else {
    const hit = REGISTRY.find((e) => e.match.test(key));
    if (hit) {
      const { match, family, ...rest } = hit;
      record = { ...rest, family, params: PARAM_PROFILES[family] || PARAM_PROFILES.unknown };
    } else {
      record = parseLocalModel(key);
    }
  }

  if (!record) {
    record = {
      id: key,
      label: key === '<synthetic>' ? 'Message local (non facturé)' : key,
      provider: 'unknown',
      family: 'unknown',
      // `<synthetic>` est produit par Claude Code lui-même (messages d'erreur,
      // interruptions) : aucun appel réseau, donc ni coût ni empreinte.
      pricing: key === '<synthetic>' ? { input: 0, output: 0 } : null,
      context: null,
      params: key === '<synthetic>' ? { total: range(0, 0), active: range(0, 0), confidence: 'disclosed' } : PARAM_PROFILES.unknown,
    };
  }
  if (!record.params) record.params = PARAM_PROFILES[record.family] || PARAM_PROFILES.unknown;

  if (!overrides) _cache.set(key, record);
  return record;
}

module.exports = { resolveModel, CACHE_MULTIPLIERS, PARAM_PROFILES, REGISTRY, range };
