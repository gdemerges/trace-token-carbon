import { ago, until } from './format.js';

/**
 * Regroupement des jauges par produit.
 *
 * Afficher « Claude — session 5 h » puis « Claude — hebdomadaire » répétait le
 * logo et le nom à chaque ligne pour ne rien apprendre. Un bloc par produit,
 * le nom une seule fois, puis ses fenêtres : même information, moitié moins
 * de bruit, et les fenêtres d'un même quota se comparent enfin d'un coup d'œil.
 */

/** Provenance de l'échelle, en clair. */
export const ORIGIN = {
  live: 'en direct',
  'live-stale': 'relevé daté',
  user: 'calé par vous',
  configured: 'plafond renseigné',
  provider: 'donné par le fournisseur',
  derived: 'déduit du dernier relevé',
  reset: 'fenêtre réinitialisée',
};

export function originLabel(g) {
  if (g.limitSource === 'live-stale' && g.reportedAt) return `relevé ${ago(g.reportedAt)}`;
  // Un relevé en direct n'est pas rafraîchi en continu : la cadence est de
  // quelques minutes pour ne pas se faire limiter par l'API. Passé une minute
  // on affiche donc son âge — sans quoi un chiffre de quatre minutes se
  // présenterait comme instantané et paraîtrait « bloqué » à qui vient de
  // consommer des tokens.
  if (g.limitSource === 'live' && g.reportedAt) {
    const age = Date.now() - g.reportedAt;
    if (age > 60000) return `en direct · ${ago(g.reportedAt)}`;
  }
  return ORIGIN[g.limitSource] || 'échelle inconnue';
}

/** Échéance ou nature de la fenêtre, côté gauche de la ligne. */
export function timingLabel(g) {
  const left = until(g.resetsAt);
  if (left) return `réinit. dans ${left}`;
  if (g.limitSource === 'reset') return 'réinitialisée depuis';
  return 'fenêtre glissante';
}

/**
 * Groupe les jauges par produit, en conservant un ordre stable.
 *
 * Les produits dont l'échelle vient du serveur passent devant : c'est
 * l'information la plus fiable, et généralement celle qu'on vient consulter.
 * À l'intérieur d'un bloc, l'ordre des fenêtres est celui du cœur (la plus
 * courte d'abord), qui est celui qui sature en premier.
 */
export function groupByProduct(gauges) {
  const blocks = new Map();
  for (const g of gauges) {
    const key = g.product || g.provider || 'autre';
    if (!blocks.has(key)) blocks.set(key, { product: key, provider: g.provider, gauges: [] });
    blocks.get(key).gauges.push(g);
  }

  for (const b of blocks.values()) {
    // Quand toutes les fenêtres d'un produit partagent la même provenance —
    // le cas courant — on la remonte en tête du bloc au lieu de la répéter.
    const origins = new Set(b.gauges.map((g) => originLabel(g)));
    b.origin = origins.size === 1 ? [...origins][0] : null;
    b.rank = b.gauges.some((g) => g.limitSource === 'live') ? 0 : b.gauges.some((g) => g.percent != null) ? 1 : 2;
    b.peak = Math.max(...b.gauges.map((g) => g.percent || 0));
  }

  return [...blocks.values()].sort((a, b) => a.rank - b.rank || b.peak - a.peak);
}
