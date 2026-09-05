'use strict';

const { t } = require('../i18n');

/**
 * Ce que la barre d'état affiche, et pour quelle fenêtre.
 *
 * Ces fonctions vivaient dans `src/main/index.js`, mêlées à Electron, et
 * n'étaient donc couvertes par aucun test — 79 tests sur le cœur, zéro sur le
 * processus principal. Elles n'ont pourtant rien d'électronique : ce sont des
 * décisions d'affichage à partir d'un instantané. Sorties d'ici, elles se
 * vérifient en `node --test` comme le reste.
 *
 * Rien dans ce fichier n'importe `electron`.
 */

/**
 * La jauge la plus parlante d'un coup d'œil : la plus remplie.
 *
 * À égalité de remplissage, la fenêtre la plus COURTE l'emporte : c'est elle
 * qui bloquera en premier, et c'est donc elle qu'on veut lire dans la barre.
 */
function primaryGauge(snap) {
  if (!snap || !snap.gauges || !snap.gauges.length) return null;
  const withPct = snap.gauges.filter((g) => g.percent != null);
  if (!withPct.length) return null;
  return withPct.reduce((a, b) => {
    if (b.percent !== a.percent) return b.percent > a.percent ? b : a;
    return (b.windowHours || Infinity) < (a.windowHours || Infinity) ? b : a;
  });
}

/**
 * Texte de la barre d'état, selon la métrique choisie.
 *
 * Il partage la largeur avec l'horloge et tout ce que l'utilisateur y a déjà
 * mis : chaque caractère se paie. D'où les unités compactes, et le « — » quand
 * il n'y a rien de sûr à dire — un « 0 % » inventé serait pire que rien.
 */
function trayTitle(snap, config = {}) {
  if (!snap) return '';
  const totals = snap.report.totals;
  switch (config.trayMetric) {
    case 'tokens': {
      const n = totals.tokens.total;
      return n >= 1e9 ? `${(n / 1e9).toFixed(1)} Md` : `${Math.round(n / 1e6)} M`;
    }
    case 'cost':
      return `$${totals.costUSD.toFixed(0)}`;
    case 'carbon':
      return `${(totals.carbon.gramsCO2e.mid / 1000).toFixed(1)} kg`;
    case 'session':
    default: {
      const g = primaryGauge(snap);
      return g ? `${Math.round(g.percent)} %` : t('tray.none');
    }
  }
}

/** Une ligne par fenêtre, plus le total de la période. */
function trayTooltip(snap) {
  const lines = ['TRACE'];
  if (!snap) return lines.join('\n');

  for (const g of snap.gauges) {
    const pct = g.percent != null ? `${Math.round(g.percent)} %` : t('tray.none');
    // La trajectoire ne tient pas dans le titre de la barre, mais l'infobulle
    // a la place : c'est là qu'elle rend le plus de service, puisqu'on y passe
    // précisément quand on se demande s'il faut lever le pied.
    const p = g.projection && g.projection.beforeReset
      ? ` · ${t('tray.full', { when: durationLabel(g.projection.inMs) })}`
      : '';
    lines.push(`${g.fullLabel || g.label} : ${pct}${p}`);
  }

  const totals = snap.report.totals;
  lines.push(t('tray.totals', {
    days: snap.range.days,
    cost: `$${totals.costUSD.toFixed(2)}`,
    carbon: `${(totals.carbon.gramsCO2e.mid / 1000).toFixed(1)} kg`,
  }));
  return lines.join('\n');
}

/** Durée compacte, pour une infobulle : « 42 min », « 3 h 10 », « 2 j ». */
function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return t('duration.moment');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return t('duration.days', { n: Math.floor(h / 24) });
  if (h > 0) return t('duration.hoursMinutes', { h, m: String(m).padStart(2, '0') });
  return t('duration.minutes', { n: m });
}

/**
 * Instantané à envoyer à une fenêtre donnée.
 *
 * Le popover et le tableau de bord regardent des périodes différentes. Sans
 * cette indirection, le rafraîchissement de fond diffusait à tout le monde
 * l'instantané calculé pour la période PAR DÉFAUT : une vue « 1 an » repassait
 * silencieusement à 30 jours au bout d'une minute, le sélecteur continuant
 * d'afficher « 1 an ». L'interface mentait sur ce qu'elle montrait.
 *
 * On ne recalcule que si la période demandée diffère réellement de celle déjà
 * calculée — un instantané complet coûte une dizaine de millisecondes, inutile
 * de le refaire pour chaque fenêtre qui regarde la même chose.
 *
 * @param {?object} state  état courant du cœur (null tant que rien n'est chargé)
 * @param {?object} snap   instantané par défaut, déjà calculé
 * @param {*} days         période demandée par cette fenêtre (undefined = défaut)
 * @param {function} compute  `core.snapshot`, injecté pour rester testable
 */
function snapshotFor(state, snap, days, compute) {
  if (!state || days == null || !snap) return snap;
  if (days === snap.range.days) return snap;
  // « tout l'historique » se compare à `range.all`, pas à un nombre de jours :
  // `snap.range.days` vaut alors la profondeur réelle des données, qui ne
  // coïncide avec la demande que par accident.
  if (days === 'all' && snap.range.all) return snap;
  return compute(state, { days });
}

module.exports = { primaryGauge, trayTitle, trayTooltip, durationLabel, snapshotFor };
