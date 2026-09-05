'use strict';

const { emptyTokens, addTokens } = require('./util');
const provenance = require('./provenance');
const { t } = require('../i18n');

/**
 * Événements utilisables pour reconstruire l'occupation d'une fenêtre.
 *
 * Seules les sources à granularité « requête » conviennent. Un agrégat
 * journalier est horodaté à minuit : le verser dans une fenêtre de cinq heures
 * déversait la consommation d'une journée entière — et de toutes les machines
 * de l'organisation — dans la seule fenêtre contenant minuit. La jauge
 * affichait alors un pic sans rapport avec ce que la machine avait fait.
 */
function windowEvents(events, family) {
  return events.filter((e) => provenance.isRequestGrain(e.source) && provenance.meta(e.source).family === family);
}

/**
 * Reconstruction des fenêtres de limitation de débit.
 *
 * Le problème : les plans Claude raisonnent en fenêtres glissantes (5 heures,
 * puis 7 jours) dont le plafond n'est publié nulle part et varie selon le plan
 * et le modèle. On ne peut donc pas coder un seuil en dur sans mentir.
 *
 * La solution retenue, par ordre de fiabilité décroissante :
 *
 *  1. Le fournisseur donne directement un pourcentage (Codex le fait) — on le
 *     prend tel quel, c'est le serveur qui parle.
 *  2. L'utilisateur a relevé son pourcentage réel (via `/usage` dans Claude
 *     Code) et l'a saisi : TRACE remonte au plafond depuis ce point. C'est la
 *     seule méthode exacte côté Anthropic, parce que c'est la seule qui
 *     s'appuie sur une vérité observée plutôt que déduite.
 *  3. Rien de tout cela : on affiche la consommation brute de la fenêtre, SANS
 *     pourcentage. Une jauge sans échelle vaut mieux qu'une jauge fausse.
 *
 * Une quatrième méthode a été essayée puis retirée : l'auto-calibrage sur un
 * refus 429 passé. Confrontée à la réalité, elle s'écartait d'un facteur 2,6
 * (elle annonçait 31 % pour 79 % réels), parce que ni la fenêtre exacte du
 * refus ni la pondération interne d'Anthropic ne sont connues. Elle sert
 * encore d'indication chiffrée dans le détail d'une jauge, mais ne pilote plus
 * aucun pourcentage affiché : sous-estimer son occupation ferait croire à une
 * marge inexistante, ce qui est précisément le risque contre lequel cet outil
 * existe.
 */

/**
 * Fenêtres Anthropic. Le nom du fournisseur fait partie du libellé : dans une
 * liste qui mélange Claude et Codex, « Session (5 h) » toute seule n'apprend
 * rien sur ce qu'on regarde.
 *
 * `liveOnly` marque une fenêtre qu'on n'affiche que si le serveur la
 * mentionne : la limite Opus hebdomadaire n'existe pas sur tous les plans, et
 * une jauge vide en permanence serait du bruit.
 */
const WINDOWS = [
  { id: 'five_hour', hours: 5, providers: ['anthropic'] },
  { id: 'weekly', hours: 168, providers: ['anthropic'] },
  { id: 'weekly_opus', hours: 168, providers: ['anthropic'], liveOnly: true },
];

/** Libellé d'une fenêtre Anthropic, dans la langue courante. */
const windowLabel = (id) => t(`window.${id}`);

/**
 * Nom du produit auquel la fenêtre se rattache. Distinct de `provider` : on
 * dit « Codex » et non « OpenAI », parce que c'est le nom sous lequel
 * l'utilisateur connaît la limite qu'il regarde.
 */
const PRODUCT = { anthropic: 'Claude', openai: 'Codex' };

/**
 * Nomme une fenêtre à partir de sa durée.
 *
 * La première version appelait « Hebdomadaire » tout ce qui dépassait 168 h.
 * Le jour où Codex a ajouté une fenêtre mensuelle (43 200 min), deux lignes
 * homonymes se sont retrouvées côte à côte. Le libellé doit suivre la durée
 * réelle, y compris pour des durées qu'on n'avait pas anticipées.
 */
function durationLabel(hours) {
  if (hours < 24) return t('window.session', { n: Math.round(hours) });
  const days = Math.round(hours / 24);
  if (days === 1) return t('window.daily');
  if (days === 7) return t('window.weekly');
  if (days >= 28 && days <= 31) return t('window.monthly');
  return t('window.nDays', { n: days });
}

/**
 * Écarte les fenêtres qu'un fournisseur ne rapporte plus.
 *
 * Codex publie toutes ses fenêtres dans le même événement : celles dont le
 * dernier relevé est nettement antérieur au relevé le plus récent ont disparu
 * de son jeu de limites (changement de formule, évolution de l'API). Les
 * garder produisait des jauges fantômes — une fenêtre de 5 h vieille de
 * 54 jours affichée à côté d'une fenêtre mensuelle du jour.
 */
const OBSOLETE_AFTER_MS = 24 * 3600 * 1000;

/**
 * Durée au-delà de laquelle un relevé serveur cesse d'être présenté comme du
 * direct. Elle suit la cadence d'interrogation : à un relevé tous les quarts
 * d'heure, exiger moins marquerait « daté » un relevé parfaitement normal.
 */
const LIVE_FRESH_MS = 45 * 60 * 1000;

/** Somme des tokens et requêtes sur un intervalle. */
function consumptionBetween(events, from, to, filter) {
  const tokens = emptyTokens();
  let requests = 0;
  const byModel = {};
  for (const e of events) {
    if (e.ts < from || e.ts > to) continue;
    if (filter && !filter(e)) continue;
    addTokens(tokens, e.tokens);
    requests += e.requests || 1;
    const m = byModel[e.model] || (byModel[e.model] = emptyTokens());
    addTokens(m, e.tokens);
  }
  return { tokens, requests, byModel };
}

/**
 * Le poids d'un token vis-à-vis d'un quota n'est pas uniforme : une lecture de
 * cache pèse bien moins qu'un token généré. On calcule donc une consommation
 * « pondérée », qui suit de bien plus près le comportement réel des plafonds
 * qu'un total brut dominé par le cache.
 */
function weightedUsage(tokens) {
  return (
    (tokens.input || 0) +
    (tokens.output || 0) * 5 +
    (tokens.cacheWrite || 0) * 1.25 +
    (tokens.cacheRead || 0) * 0.1
  );
}

/**
 * Déduit le plafond d'une fenêtre à partir d'un pourcentage relevé par
 * l'utilisateur : si 3,8 M pondérés correspondent à 72 %, le plafond vaut
 * 3,8 M / 0,72. C'est un simple produit en croix, mais ancré sur une valeur
 * vraie plutôt que sur une inférence.
 */
function limitFromObservedPercent(events, windowStart, now, percent) {
  if (!percent || percent <= 0 || percent > 100) return null;
  const { tokens } = consumptionBetween(events, windowStart, now);
  const used = weightedUsage(tokens);
  if (used <= 0) return null;
  return used / (percent / 100);
}

/**
 * Calibre un plafond à partir des refus 429 observés.
 * Renvoie null si aucun refus exploitable n'a été enregistré.
 */
function calibrateFromRejections(events, quota, windowId, hours) {
  const rejections = quota.filter(
    (q) =>
      q.source === 'claude-code' &&
      q.status === 'rejected' &&
      q.type === windowId &&
      q.resetsAt &&
      // Un plafond de dépense mensuel bloque la requête sans que la fenêtre
      // soit pleine : le retenir fausserait complètement l'échelle.
      (q.cause === 'window' || q.cause === undefined)
  );
  if (!rejections.length) return null;

  let best = 0;
  let at = 0;
  for (const r of rejections) {
    const windowStart = r.resetsAt - hours * 3600 * 1000;
    const { tokens } = consumptionBetween(events, windowStart, r.ts);
    const used = weightedUsage(tokens);
    if (used > best) {
      best = used;
      at = r.ts;
    }
  }
  return best > 0 ? { limit: best, observedAt: at, samples: rejections.length } : null;
}

/**
 * Fenêtre d'observation de la cadence courante.
 *
 * Assez longue pour ne pas confondre une pause de deux minutes avec un arrêt,
 * assez courte pour que la projection suive un changement de rythme. Sur une
 * fenêtre de cinq heures, prendre la moyenne depuis le début donnerait une
 * cadence qui ne décrit plus rien : c'est le rythme des dernières minutes qui
 * dit quand on heurtera le plafond.
 */
const PACE_WINDOW_MS = 45 * 60 * 1000;

/**
 * Estime QUAND la fenêtre sera pleine, au rythme des dernières minutes.
 *
 * TRACE disait où vous en êtes, jamais où vous alliez. Or prévenir à 80 % ne
 * laisse presque pas de marge quand on consomme vite, et en laisse beaucoup
 * quand on relit du code : c'est la trajectoire, pas le niveau, qui indique
 * s'il faut lever le pied.
 *
 * Trois refus délibérés, qui valent mieux qu'une projection séduisante :
 *
 *  - **Sans échelle fiable, pas de projection.** Il faut un plafond, mesuré
 *    ou déduit d'un pourcentage communiqué par le serveur. Extrapoler sur une
 *    échelle inventée reviendrait à annoncer une heure précise à partir de
 *    rien.
 *  - **Sans activité récente, pas de projection.** Une cadence nulle ne
 *    sature jamais ; annoncer « dans 340 h » serait du bruit.
 *  - **Une saturation postérieure à la réinitialisation n'en est pas une.**
 *    Atteindre le plafond à 3 h du matin n'a aucune importance si la fenêtre
 *    se vide à 2 h. C'est ce test qui distingue une alerte utile d'une
 *    inquiétude gratuite.
 *
 * @returns {?{at:number, inMs:number, ratePerHour:number, beforeReset:boolean}}
 */
function projectSaturation(gauge, events, now = Date.now()) {
  if (!gauge || gauge.percent == null || gauge.percent >= 100) return null;

  // Plafond : celui qu'on connaît, sinon celui qu'implique le pourcentage du
  // serveur rapporté à la consommation qu'on a mesurée sous lui.
  const limit = gauge.limit || (gauge.used > 0 && gauge.percent > 0 ? gauge.used / (gauge.percent / 100) : null);
  if (!limit || !Number.isFinite(limit)) return null;

  const family = gauge.provider === 'openai' ? 'openai' : 'anthropic';
  const recent = consumptionBetween(windowEvents(events, family), now - PACE_WINDOW_MS, now);
  const paceUsed = weightedUsage(recent.tokens);
  if (paceUsed <= 0) return null;

  const ratePerMs = paceUsed / PACE_WINDOW_MS;
  const remaining = ((100 - gauge.percent) / 100) * limit;
  const inMs = remaining / ratePerMs;
  if (!Number.isFinite(inMs) || inMs <= 0) return null;

  return {
    at: now + inMs,
    inMs,
    ratePerHour: ratePerMs * 3600000,
    // Une fenêtre glissante n'annonce pas de réinitialisation : rien ne vient
    // absorber la trajectoire, la saturation est donc à prendre au sérieux.
    beforeReset: gauge.resetsAt ? now + inMs < gauge.resetsAt : true,
  };
}

/**
 * Construit les jauges à afficher.
 * @returns {Array} jauges prêtes pour l'interface
 */
function computeGauges(events, quota, config = {}, now = Date.now()) {
  const gauges = [];

  // --- Anthropic / Claude Code -------------------------------------------
  const claudeEvents = windowEvents(events, 'anthropic');
  if (claudeEvents.length) {
    for (const w of WINDOWS) {
      // Une réinitialisation annoncée dans le futur donne l'ancrage exact de
      // la fenêtre. À défaut, on retombe sur une fenêtre glissante des
      // `hours` dernières heures — et surtout PAS sur `now + hours`, qui
      // produirait une fenêtre vide commençant à l'instant présent.
      const known = quota
        .filter((q) => q.type === w.id && q.resetsAt > now)
        .sort((a, b) => b.ts - a.ts)[0];
      const resetsAt = known ? known.resetsAt : null;
      const startsAt = known ? resetsAt - w.hours * 3600 * 1000 : now - w.hours * 3600 * 1000;
      const rolling = !known;

      const { tokens, requests, byModel } = consumptionBetween(claudeEvents, startsAt, now);
      const used = weightedUsage(tokens);

      // Relevé en direct du serveur : il tranche. Aucune reconstruction
      // locale ne peut faire mieux qu'un chiffre communiqué par Anthropic.
      // Un relevé n'est « en direct » que tant qu'il est frais. Passé ce
      // délai on l'affiche encore — c'est la meilleure information
      // disponible — mais en disant son âge, jamais comme s'il venait
      // d'arriver. Le seuil suit la cadence d'interrogation : à un relevé
      // tous les quarts d'heure, exiger moins de 20 minutes marquerait
      // « daté » un relevé parfaitement normal.
      const live = quota
        .filter((q) => q.source === 'anthropic-oauth' && q.type === w.id && q.usedPercent != null)
        .sort((a, b) => b.ts - a.ts)[0];
      const liveAge = live ? now - live.ts : null;
      const liveFresh = live && liveAge < LIVE_FRESH_MS;

      // Fenêtre propre à certains plans : sans relevé du serveur, on ne sait
      // même pas si elle s'applique à ce compte. On ne l'invente pas.
      if (w.liveOnly && !live) continue;

      const configured = (config.limits || {})[w.id];
      const meta = (config.limitMeta || {})[w.id] || {};
      const calibrated = calibrateFromRejections(claudeEvents, quota, w.id, w.hours);

      let limit = null;
      let limitSource = null;
      const approximate = false;
      if (configured) {
        limit = configured;
        limitSource = meta.source === 'user' ? 'user' : 'configured';
      }
      // `calibrated` reste calculé et exposé pour information, mais ne devient
      // jamais l'échelle affichée — voir l'en-tête de ce fichier.

      // Le direct écrase tout ce qui précède.
      const percent = live ? live.usedPercent : limit ? Math.min(100, (used / limit) * 100) : null;
      if (live) limitSource = liveFresh ? 'live' : 'live-stale';

      gauges.push({
        id: `anthropic-${w.id}`,
        provider: 'anthropic',
        product: PRODUCT.anthropic,
        label: windowLabel(w.id),
        fullLabel: t('window.full', { product: PRODUCT.anthropic, window: windowLabel(w.id).toLowerCase() }),
        windowHours: w.hours,
        startsAt,
        resetsAt: live && live.resetsAt ? live.resetsAt : resetsAt,
        rolling: live && live.resetsAt ? false : rolling,
        tokens,
        requests,
        byModel,
        used,
        limit,
        limitSource,
        calibration: calibrated,
        calibratedAt: meta.at || null,
        approximate,
        percent,
        liveAge,
        stale: !!live && !liveFresh,
        reportedAt: live ? live.ts : undefined,
        // Inutile de proposer un calage manuel quand le serveur répond.
        calibratable: !live,
      });
    }
  }

  // --- Codex ---------------------------------------------------------------
  // Le serveur fournit un pourcentage, mais daté du dernier tour. Si la
  // fenêtre correspondante a expiré depuis, ce chiffre ne décrit plus rien :
  // la fenêtre s'est réinitialisée. On s'en sert alors comme point de
  // calibrage — le pourcentage relevé et la consommation locale mesurée sur
  // cette même fenêtre donnent le plafond — puis on recalcule l'occupation de
  // la fenêtre COURANTE. Résultat : une jauge toujours à jour, à 0 % si vous
  // n'avez pas touché à Codex depuis.
  const codexEvents = windowEvents(events, 'openai');
  const codexQuota = quota.filter((q) => q.source === 'codex-cli' && q.usedPercent != null);
  const byWindow = new Map();
  for (const q of codexQuota) {
    const cur = byWindow.get(q.type);
    if (!cur || q.ts > cur.ts) byWindow.set(q.type, q);
  }

  // Le relevé le plus récent fait référence : tout ce qui n'y figurait pas
  // n'est plus rapporté par le fournisseur.
  const newestReport = Math.max(0, ...[...byWindow.values()].map((q) => q.ts));
  for (const [type, q] of byWindow) {
    if (newestReport - q.ts > OBSOLETE_AFTER_MS) byWindow.delete(type);
  }

  for (const [type, q] of byWindow) {
    const hours = q.windowMinutes ? q.windowMinutes / 60 : 5;
    const reportedResetsAt = q.resetsAt || q.ts + hours * 3600 * 1000;
    const expired = reportedResetsAt <= now;

    // Plafond déduit du dernier relevé du fournisseur.
    let limit = null;
    if (q.usedPercent > 0) {
      const reportedStart = reportedResetsAt - hours * 3600 * 1000;
      const atReport = consumptionBetween(codexEvents, reportedStart, q.ts);
      const usedAtReport = weightedUsage(atReport.tokens);
      if (usedAtReport > 0) limit = usedAtReport / (q.usedPercent / 100);
    }

    // Fenêtre à afficher : celle du fournisseur si elle court encore, sinon
    // une fenêtre glissante se terminant maintenant.
    const resetsAt = expired ? null : reportedResetsAt;
    const startsAt = expired ? now - hours * 3600 * 1000 : reportedResetsAt - hours * 3600 * 1000;

    const { tokens, requests } = consumptionBetween(codexEvents, startsAt, now);
    const used = weightedUsage(tokens);

    let percent;
    let limitSource;
    let approximate = false;
    if (!expired) {
      // La fenêtre annoncée court toujours : le chiffre du serveur fait foi.
      percent = q.usedPercent;
      limitSource = 'provider';
    } else if (limit) {
      percent = Math.min(100, (used / limit) * 100);
      limitSource = 'derived';
      approximate = true;
    } else {
      // Aucune activité depuis la réinitialisation : la fenêtre est vide.
      percent = used > 0 ? null : 0;
      limitSource = used > 0 ? null : 'reset';
    }

    gauges.push({
      id: `codex-${type}`,
      provider: 'openai',
      product: PRODUCT.openai,
      label: durationLabel(hours),
      fullLabel: t('window.full', { product: PRODUCT.openai, window: durationLabel(hours).toLowerCase() }),
      windowHours: hours,
      startsAt,
      resetsAt,
      rolling: expired,
      tokens,
      requests,
      byModel: {},
      used,
      limit,
      limitSource,
      approximate,
      percent,
      reportedAt: q.ts,
      // Le relevé n'est plus « périmé » : on ne l'affiche plus tel quel, on
      // s'en sert pour calculer l'état courant.
      stale: false,
      plan: q.plan,
      calibratable: false,
    });
  }

  // La projection se pose en dernier : elle a besoin de la jauge terminée,
  // pourcentage et plafond compris.
  for (const g of gauges) g.projection = projectSaturation(g, events, now);

  return gauges;
}

/**
 * Recalibre une fenêtre à partir d'un pourcentage relevé par l'utilisateur.
 * Renvoie la configuration mise à jour, prête à être enregistrée.
 */
function applyUserCalibration(config, events, quota, gaugeId, percent, now = Date.now()) {
  const windowId = String(gaugeId).replace(/^anthropic-/, '');
  const w = WINDOWS.find((x) => x.id === windowId);
  if (!w) throw new Error(t('window.unknown', { id: gaugeId }));

  const claudeEvents = windowEvents(events, 'anthropic');
  const known = quota.filter((q) => q.type === w.id && q.resetsAt > now).sort((a, b) => b.ts - a.ts)[0];
  const startsAt = known ? known.resetsAt - w.hours * 3600 * 1000 : now - w.hours * 3600 * 1000;

  const limit = limitFromObservedPercent(claudeEvents, startsAt, now, percent);
  if (!limit) {
    throw new Error(t('window.noUsage'));
  }

  return {
    ...config,
    limits: { ...(config.limits || {}), [w.id]: limit },
    limitMeta: { ...(config.limitMeta || {}), [w.id]: { source: 'user', at: now, fromPercent: percent } },
  };
}

module.exports = {
  windowEvents,
  windowLabel,
  projectSaturation,
  PACE_WINDOW_MS,
  computeGauges,
  durationLabel,
  LIVE_FRESH_MS,
  weightedUsage,
  consumptionBetween,
  applyUserCalibration,
  limitFromObservedPercent,
  WINDOWS,
};
