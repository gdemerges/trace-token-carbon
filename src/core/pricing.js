'use strict';

const { CACHE_MULTIPLIERS } = require('./models');

/**
 * Coût monétaire d'un volume de tokens, en USD.
 *
 * Les tarifs sont exprimés par million de tokens. Le cache suit les
 * multiplicateurs Anthropic : lecture 0,1x le tarif d'entrée, écriture 1,25x
 * en TTL 5 minutes et 2x en TTL 1 heure — d'où la distinction entre
 * `cacheWrite5m` et `cacheWrite1h`, que les logs de Claude Code fournissent.
 *
 * Renvoie `null` (et non 0) quand le modèle n'a pas de tarif connu : un coût
 * inconnu ne doit pas se fondre dans un total en se faisant passer pour la
 * gratuité. Les modèles locaux, eux, valent bien 0.
 */
function cost(tokens, model) {
  const p = model.pricing;
  if (!p) return model.provider === 'local' ? 0 : null;

  const perM = (n, rate) => ((n || 0) / 1_000_000) * rate;

  const write5m = tokens.cacheWrite5m != null ? tokens.cacheWrite5m : tokens.cacheWrite || 0;
  const write1h = tokens.cacheWrite1h || 0;

  return (
    perM(tokens.input, p.input) +
    perM(tokens.output, p.output) +
    perM(tokens.cacheRead, p.input * CACHE_MULTIPLIERS.read) +
    perM(write5m, p.input * CACHE_MULTIPLIERS.write5m) +
    perM(write1h, p.input * CACHE_MULTIPLIERS.write1h)
  );
}

/**
 * Ce que le même volume aurait coûté SANS cache : utile pour chiffrer ce que
 * le cache fait économiser, qui est souvent le poste d'optimisation n°1.
 */
function costWithoutCache(tokens, model) {
  const p = model.pricing;
  if (!p) return model.provider === 'local' ? 0 : null;
  const allInput = (tokens.input || 0) + (tokens.cacheRead || 0) + (tokens.cacheWrite || 0);
  return (allInput / 1_000_000) * p.input + ((tokens.output || 0) / 1_000_000) * p.output;
}

module.exports = { cost, costWithoutCache };
