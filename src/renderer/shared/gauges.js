import { ago, until } from './format.js';
import { t } from './i18n.js';

/**
 * Regroupement des jauges par produit.
 *
 * Afficher « Claude — session 5 h » puis « Claude — hebdomadaire » répétait le
 * logo et le nom à chaque ligne pour ne rien apprendre. Un bloc par produit,
 * le nom une seule fois, puis ses fenêtres : même information, moitié moins
 * de bruit, et les fenêtres d'un même quota se comparent enfin d'un coup d'œil.
 */

/** Provenance de l'échelle, en clair. */
export const originText = (limitSource) =>
  ['live', 'live-stale', 'user', 'configured', 'provider', 'derived', 'reset'].includes(limitSource)
    ? t(`origin.${limitSource}`)
    : null;

/**
 * Échéance du prochain relevé, en minutes rondes.
 *
 * Dire l'âge d'un chiffre ne suffit pas : « il y a 12 min » explique d'où
 * vient la valeur, mais laisse croire que plus rien ne viendra. C'est
 * exactement ainsi qu'une cadence normale se lit comme une panne, et que
 * l'utilisateur prend l'habitude de cliquer sur ⟳ à chaque fois.
 */
function nextReadingLabel(g) {
  if (!g.nextLiveIn || g.nextLiveIn <= 0) return null;
  const min = Math.ceil(g.nextLiveIn / 60000);
  return min <= 1 ? t('origin.nextSoon') : t('origin.nextIn', { n: min });
}

export function originLabel(g) {
  const next = nextReadingLabel(g);
  if (g.limitSource === 'live-stale' && g.reportedAt) {
    const read = t('fmt.readAt', { when: ago(g.reportedAt) });
    return next ? t('origin.join', { a: read, b: next }) : read;
  }
  // Un relevé en direct n'est pas rafraîchi en continu : la cadence est de
  // quelques minutes pour ne pas se faire limiter par l'API. Passé une minute
  // on affiche donc son âge — sans quoi un chiffre de quatre minutes se
  // présenterait comme instantané et paraîtrait « bloqué » à qui vient de
  // consommer des tokens.
  if (g.limitSource === 'live' && g.reportedAt) {
    const age = Date.now() - g.reportedAt;
    const aged = t('origin.liveAged', { age: ago(g.reportedAt) });
    if (age > 60000) return next ? t('origin.join', { a: aged, b: next }) : aged;
    if (next) return t('origin.join', { a: t('origin.live'), b: next });
  }
  return originText(g.limitSource) || t('origin.unknown');
}

/**
 * Trajectoire : quand la fenêtre sera pleine, au rythme des dernières minutes.
 *
 * N'apparaît que si la saturation tombe AVANT la réinitialisation. Une
 * projection qui déborde de la fenêtre n'annonce rien — la fenêtre se vide
 * d'abord — et l'afficher quand même transformerait un fonctionnement normal
 * en avertissement permanent.
 *
 * Sur l'hebdomadaire, le délai inclut les pauses imposées par la limite de
 * cinq heures. Le dire change la lecture du chiffre : ce n'est pas du temps de
 * travail restant, c'est une date.
 */
export function projectionLabel(g) {
  const p = g.projection;
  if (!p || !p.beforeReset) return null;
  const left = until(p.at);
  if (!left) return t('gauge.fullImminent');
  return t(p.throttled ? 'gauge.fullInThrottled' : 'gauge.fullIn', { when: left });
}

/** Échéance ou nature de la fenêtre, côté gauche de la ligne. */
export function timingLabel(g) {
  const left = until(g.resetsAt);
  if (left) return t('fmt.resetIn', { when: left });
  if (g.limitSource === 'reset') return t('fmt.resetSince');
  return t('fmt.rolling');
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
