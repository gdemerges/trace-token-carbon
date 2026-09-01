'use strict';

/**
 * Alertes de limite.
 *
 * C'était le trou central de TRACE : l'application savait que vous étiez à
 * 87 % d'une fenêtre et ne disait rien. Un outil dont la raison d'être est de
 * prévenir avant la limite doit prévenir.
 *
 * Trois règles gouvernent ce module, et elles comptent plus que le code :
 *
 *  1. On n'alerte QUE sur une échelle digne de confiance — relevé serveur ou
 *     calage manuel. Jamais sur une estimation : celle déduite d'un refus 429
 *     s'est révélée fausse d'un facteur 2,6, et une alerte fausse détruit la
 *     confiance dans toutes les autres.
 *  2. Une alerte par seuil et par fenêtre. Le franchissement d'un seuil est un
 *     événement, pas un état : répéter la notification à chaque cycle de 60 s
 *     transformerait l'outil en nuisance.
 *  3. Une nouvelle fenêtre remet les compteurs à zéro. L'identité d'une
 *     fenêtre inclut son instant de réinitialisation : après un reset, les
 *     mêmes seuils peuvent de nouveau se déclencher.
 */

const DEFAULT_THRESHOLDS = [80, 95];

/** Sources d'échelle en lesquelles on a assez confiance pour alerter. */
const TRUSTED = new Set(['live', 'live-stale', 'user', 'provider', 'configured']);

/**
 * Identité d'une fenêtre : elle change à chaque réinitialisation, ce qui
 * réarme les seuils.
 *
 * Une fenêtre glissante n'a pas d'instant de réinitialisation annoncé : son
 * début avance en continu. On la quantifie alors à l'heure, ce qui réarme les
 * seuils une fois par heure tant que la consommation reste haute. C'est
 * délibéré : une saturation qui dure une demi-journée mérite plus d'un
 * rappel, mais pas un rappel toutes les minutes.
 */
function windowKey(g) {
  return g.resetsAt ? `${g.id}@${g.resetsAt}` : `${g.id}~${Math.floor((g.startsAt || 0) / 3600000)}`;
}

/**
 * Décide quelles notifications émettre.
 *
 * @param {Array} gauges  jauges courantes
 * @param {object} config préférences (alerts.enabled, alerts.thresholds)
 * @param {object} state  états déjà notifiés : { [windowKey]: [seuils] }
 * @returns {{notifications: Array, state: object}}
 */
function evaluate(gauges, config = {}, state = {}, now = Date.now()) {
  const settings = config.alerts || {};
  if (settings.enabled === false) return { notifications: [], state };

  const thresholds = (settings.thresholds && settings.thresholds.length ? settings.thresholds : DEFAULT_THRESHOLDS)
    .filter((t) => Number.isFinite(t) && t > 0 && t <= 100)
    .sort((a, b) => a - b);

  const notifications = [];
  const next = {};

  for (const g of gauges) {
    if (g.percent == null || g.approximate || !TRUSTED.has(g.limitSource)) continue;

    const key = windowKey(g);
    const already = new Set(state[key] || []);
    const fired = [...already];

    // Seul le seuil le PLUS HAUT franchi est notifié : passer de 0 à 96 % en
    // un cycle ne doit pas produire deux notifications d'un coup.
    const crossed = thresholds.filter((t) => g.percent >= t && !already.has(t));
    if (crossed.length) {
      const top = crossed[crossed.length - 1];
      notifications.push({
        key,
        gaugeId: g.id,
        threshold: top,
        percent: g.percent,
        title: `${g.product || 'Limite'} — ${Math.round(g.percent)} % de ${g.label.toLowerCase()}`,
        body: g.resetsAt
          ? `Réinitialisation ${formatUntil(g.resetsAt, now)}.`
          : 'Fenêtre glissante, pas de réinitialisation annoncée.',
        urgency: top >= 95 ? 'critical' : 'normal',
      });
      fired.push(...crossed);
    }

    // On ne conserve l'état que des fenêtres encore vivantes : sans cet
    // élagage, la mémoire des notifications grossirait indéfiniment.
    if (fired.length) next[key] = fired;
  }

  return { notifications, state: next };
}

function formatUntil(ts, now) {
  const ms = ts - now;
  if (ms <= 0) return 'imminente';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `dans ${Math.floor(h / 24)} j`;
  if (h > 0) return `dans ${h} h ${String(m).padStart(2, '0')}`;
  return `dans ${m} min`;
}

module.exports = { evaluate, windowKey, DEFAULT_THRESHOLDS, TRUSTED };
