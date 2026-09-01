'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { homeDir } = require('../util');

/**
 * Consommation Claude EN DIRECT, via l'endpoint que Claude Code interroge
 * lui-même pour sa commande `/usage`.
 *
 * Pourquoi ce collecteur existe : le taux d'occupation réel des fenêtres
 * (5 heures, hebdomadaire) n'est stocké NULLE PART en local. Tout ce qu'on
 * peut faire à partir des journaux est une reconstruction approximative — et
 * mesurée sur un cas réel, elle s'écartait d'un facteur 2,6. Le seul chiffre
 * juste est celui que le serveur renvoie.
 *
 * On réutilise les identifiants OAuth déjà présents sur la machine, ceux que
 * Claude Code a déposés en s'authentifiant. TRACE ne demande jamais de mot de
 * passe, ne stocke aucun jeton, et n'appelle que cet endpoint de lecture, avec
 * les identifiants de l'utilisateur, pour ses propres données.
 *
 * Le jeton ne quitte jamais ce module : ni journal, ni configuration, ni IPC
 * vers l'interface.
 */

const SOURCE = 'anthropic-oauth';
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Cadence d'interrogation.
 *
 * Ce collecteur est le seul à faire un appel réseau à chaque cycle, et la
 * donnée qu'il rapporte bouge à l'échelle de l'heure — une fenêtre de cinq
 * heures ne change pas en vingt secondes. L'aligner sur le rafraîchissement
 * général (qui, lui, ne fait que relire des fichiers locaux) revient à
 * marteler l'API pour rien : c'est exactement ce qui a valu un 429 à la
 * première version, avec une jauge figée à la dernière valeur connue.
 */
// Cadence portée de 5 à 15 minutes après avoir repris un 429 à ce rythme.
// Deux raisons de rester très en dessous de ce qu'on croit permis :
//  - une fenêtre de cinq heures ne bouge pas en un quart d'heure, et une
//    fenêtre hebdomadaire encore moins ;
//  - TRACE partage le jeton, donc le quota de cet endpoint, avec Claude Code
//    lui-même. Chaque appel de TRACE se cumule à ceux du client officiel.
// Le bouton « Actualiser » court-circuite de toute façon cette cadence quand
// l'utilisateur veut un chiffre à la seconde.
const MIN_INTERVAL_MS = 15 * 60 * 1000;
// Deux régimes de report, parce que deux causes très différentes :
//  - un 429 signifie que le serveur nous a explicitement écartés, et en
//    conditions réelles il reste fermé bien plus que quelques minutes ;
//  - une coupure réseau ou un délai dépassé est passager, et punir dix
//    minutes une micro-coupure laisse l'utilisateur devant un chiffre figé
//    sans raison valable.
const BACKOFF_RATE_LIMIT_MS = 10 * 60 * 1000;
const BACKOFF_TRANSIENT_MS = 45 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
// Au-delà, la valeur en cache cesse d'être présentée comme « en direct ».
const FRESH_MS = 45 * 60 * 1000;

/**
 * État du collecteur, en mémoire uniquement.
 *
 * Un relevé de quota est un INSTANTANÉ, pas un événement : l'empiler dans
 * l'index persistant produisait 60 entrées en dix minutes et faisait passer un
 * relevé périmé pour une mesure courante. Il vit donc ici, remplacé à chaque
 * succès, et jamais écrit sur le disque.
 */
const cache = { fetchedAt: 0, quota: null, failures: 0, retryAfter: 0, lastError: null, forceNext: false };

/** Lit le trousseau macOS. Résout à null plutôt que de rejeter : l'absence
 *  d'identifiants est un cas normal, pas une erreur. */
function readMacKeychain() {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

/** Sur Linux et Windows, Claude Code écrit un fichier de credentials. */
function readCredentialsFile() {
  for (const p of [path.join(homeDir(), '.claude', '.credentials.json'), path.join(homeDir(), '.config', 'claude', '.credentials.json')]) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      /* absent : on essaie l'emplacement suivant */
    }
  }
  return null;
}

async function loadToken() {
  const raw = process.platform === 'darwin' ? (await readMacKeychain()) || readCredentialsFile() : readCredentialsFile() || (await readMacKeychain());
  if (!raw) return { error: "Aucun identifiant Claude Code trouvé. Connectez-vous avec `claude` d'abord." };

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    return { error: 'Identifiants Claude Code illisibles.' };
  }

  const o = creds.claudeAiOauth || creds.oauth || creds;
  const token = o.accessToken || o.access_token;
  if (!token) return { error: "Identifiants trouvés mais sans jeton d'accès." };

  const expiresAt = o.expiresAt || o.expires_at || null;
  if (expiresAt && expiresAt < Date.now()) {
    return { error: 'Jeton Claude Code expiré. Relancez `claude` pour le renouveler.' };
  }
  return { token, expiresAt };
}

/**
 * Extrait les fenêtres de limitation d'une réponse dont on ne veut pas
 * présumer la forme exacte.
 *
 * L'endpoint n'est pas documenté publiquement et sa structure peut changer :
 * plutôt que de coder un chemin rigide qui casserait en silence, on parcourt
 * l'arbre et on retient tout objet portant à la fois une notion d'occupation
 * et une notion de réinitialisation. Ce qui n'est pas reconnu est signalé,
 * jamais deviné.
 */
function extractWindows(payload) {
  const found = [];
  const seen = new Set();

  const pctOf = (o) => {
    for (const k of ['utilization', 'used_percent', 'usedPercent', 'percent_used', 'percentUsed', 'percent']) {
      if (typeof o[k] === 'number') {
        // Certaines API renvoient une fraction (0..1), d'autres un pourcentage.
        return o[k] <= 1 && o[k] >= 0 ? o[k] * 100 : o[k];
      }
    }
    return null;
  };
  const resetOf = (o) => {
    for (const k of ['resets_at', 'resetsAt', 'reset_at', 'resetAt', 'expires_at']) {
      const v = o[k];
      if (v == null) continue;
      if (typeof v === 'number') return v > 1e11 ? v : v * 1000; // secondes ou millisecondes
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
    return null;
  };

  const walk = (node, label) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${label}[${i}]`));
      return;
    }

    const pct = pctOf(node);
    const reset = resetOf(node);
    if (pct != null) {
      found.push({
        key: String(node.type || node.name || node.window || label || 'unknown'),
        percent: Math.max(0, Math.min(100, pct)),
        resetsAt: reset,
      });
    }
    for (const [k, v] of Object.entries(node)) walk(v, k);
  };

  walk(payload, 'racine');
  return found;
}

/** Fait correspondre une clé de l'API à une fenêtre connue de TRACE. */
function normalizeWindow(key) {
  const k = String(key).toLowerCase();
  if (/five_hour|5h|session|fivehour/.test(k)) return 'five_hour';
  if (/seven_day|weekly|week|7d/.test(k)) {
    return /opus/.test(k) ? 'weekly_opus' : 'weekly';
  }
  if (/opus/.test(k)) return 'weekly_opus';
  return null;
}

async function isAvailable(config = {}) {
  if (config.disableOauthUsage) return false;
  const { token } = await loadToken();
  return !!token;
}

/**
 * Ce que le collecteur renvoie quand il s'appuie sur son cache.
 *
 * Il rend TOUJOURS le dernier relevé connu, quel que soit son âge. Juger de la
 * fraîcheur ici serait une seconde décision au même sujet : `computeGauges` le
 * fait déjà, et sait afficher un relevé daté en annonçant son âge. Filtrer des
 * deux côtés a produit exactement le contraire du but recherché — le relevé
 * était jeté avant d'arriver à l'affichage, et la jauge retombait sur une
 * estimation fausse.
 */
function cached(reason) {
  const age = cache.fetchedAt ? Date.now() - cache.fetchedAt : null;
  return {
    events: [],
    quota: cache.quota || [],
    state: {},
    stats: {
      configured: true,
      events: 0,
      fromCache: true,
      ageMs: age,
      stale: age != null && age > FRESH_MS,
      nextAttemptIn: Math.max(0, cache.retryAfter - Date.now()),
      // Un report sans motif connu — hérité d'un redémarrage — doit tout de
      // même se dire : « rien ne bouge » sans explication est le pire cas.
      errors: cache.lastError
        ? [cache.lastError]
        : cache.retryAfter > Date.now()
          ? ['Relevé suspendu après un échec précédent']
          : [],
      note: reason,
    },
    // Persisté pour que le prochain démarrage ne refrappe pas l'API.
    state: {
      fetchedAt: cache.fetchedAt,
      quota: cache.quota,
      retryAfter: cache.retryAfter,
      lastError: cache.lastError,
      failures: cache.failures,
    },
  };
}

async function collect(config = {}, state = {}) {
  const now = Date.now();
  const minInterval = config.liveUsageIntervalMs || MIN_INTERVAL_MS;

  // Demande explicite de l'utilisateur (bouton « Actualiser »). Ce drapeau doit
  // être lu AVANT l'amorçage : la première version remettait `fetchedAt` à
  // zéro pour forcer un relevé, et l'amorçage ci-dessous le restaurait aussitôt
  // depuis l'état persisté — le bouton ne faisait donc plus rien. Deux
  // correctifs ajoutés séparément qui s'annulaient en silence.
  const forced = cache.forceNext;
  cache.forceNext = false;

  // Amorçage depuis l'état persisté, TOUJOURS — y compris sur une demande
  // explicite. Il ne fait que restaurer ce qu'on sait déjà : le dernier relevé
  // et un éventuel report en cours. C'est la cadence, et elle seule, que le
  // forçage doit court-circuiter.
  if (!cache.fetchedAt && state.fetchedAt) {
    cache.fetchedAt = state.fetchedAt;
    cache.quota = state.quota || null;
    cache.retryAfter = state.retryAfter || 0;
    // Le motif doit voyager avec le report. Sans lui, un redémarrage héritait
    // d'une attente muette : plus de mise à jour, et rien pour l'expliquer.
    cache.lastError = state.lastError || null;
    cache.failures = state.failures || 0;
  }

  // Le report après échec s'applique MÊME à une demande explicite : insister
  // sur un 429 ne fait que prolonger la sanction. En revanche l'interface doit
  // dire pourquoi rien ne bouge, jamais rester muette.
  if (cache.retryAfter > now) return cached('en attente après un échec');
  // Régime normal : on réutilise le dernier relevé tant qu'il est récent —
  // sauf demande explicite, qui court-circuite la cadence.
  if (!forced && cache.fetchedAt && now - cache.fetchedAt < minInterval) return cached('relevé récent réutilisé');

  const { token, error } = await loadToken();
  if (!token) return { events: [], quota: [], state: {}, stats: { configured: false, events: 0, errors: error ? [error] : [] } };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let payload;
  try {
    const res = await fetch(ENDPOINT, {
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      cache.failures++;
      // `Retry-After` fait autorité quand le serveur le donne ; sinon report
      // exponentiel, plafonné.
      const retryAfterHeader = Number(res.headers.get('retry-after'));
      const base = res.status === 429 ? BACKOFF_RATE_LIMIT_MS : BACKOFF_TRANSIENT_MS;
      const wait = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(BACKOFF_MAX_MS, base * 2 ** (cache.failures - 1));
      cache.retryAfter = Date.now() + wait;

      const hint =
        res.status === 401 ? ' — jeton refusé, relancez `claude` pour vous réauthentifier'
        : res.status === 429 ? ` — trop de requêtes, nouvelle tentative dans ${Math.round(wait / 60000)} min`
        : '';
      cache.lastError = `Anthropic ${res.status}${hint}`;
      return cached('échec du relevé');
    }
    payload = await res.json();
  } catch (e) {
    cache.failures++;
    cache.retryAfter = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_TRANSIENT_MS * 2 ** (cache.failures - 1));
    cache.lastError = e.name === 'AbortError' ? "Délai dépassé en interrogeant l'API Anthropic" : e.message;
    return cached('échec du relevé');
  } finally {
    clearTimeout(timer);
  }

  const windows = extractWindows(payload);
  const quota = [];
  for (const w of windows) {
    const type = normalizeWindow(w.key);
    if (!type) continue;
    quota.push({
      source: SOURCE,
      ts: Date.now(),
      type,
      usedPercent: w.percent,
      resetsAt: w.resetsAt,
      status: w.percent >= 100 ? 'rejected' : 'ok',
      // Chiffre du serveur : il doit primer sur toute reconstruction locale.
      authoritative: true,
    });
  }

  // Succès : on repart d'un compteur d'échecs vierge.
  cache.fetchedAt = Date.now();
  cache.quota = quota;
  cache.failures = 0;
  cache.retryAfter = 0;
  cache.lastError = null;

  return {
    events: [],
    quota,
    state: { fetchedAt: cache.fetchedAt, quota, retryAfter: 0, lastError: null, failures: 0 },
    stats: {
      configured: true,
      events: 0,
      windows: quota.length,
      ageMs: 0,
      // Si la forme de la réponse change, on veut pouvoir le diagnostiquer
      // sans deviner — sans jamais exposer le contenu.
      unrecognized: windows.length && !quota.length ? Object.keys(payload || {}) : undefined,
      errors: windows.length === 0 ? ["Réponse reçue mais aucune fenêtre reconnue — le format de l'API a peut-être changé."] : [],
    },
  };
}

/**
 * Force un relevé au prochain cycle (bouton « Actualiser »).
 *
 * On lève un drapeau plutôt que de vider le cache : vider `fetchedAt` ne
 * survivait pas à l'amorçage depuis l'état persisté, et le dernier relevé
 * connu serait perdu si l'appel échouait.
 */
function forceRefresh() {
  // On ne touche ni à `retryAfter` ni à `failures` : un report en cours vient
  // d'un refus du serveur, et cliquer sur « Actualiser » ne l'annule pas.
  // L'interface affiche alors le délai restant plutôt que de rester muette.
  cache.forceNext = true;
}

/** Vide entièrement le cache — réservé aux tests. */
function resetCache() {
  cache.fetchedAt = 0;
  cache.quota = null;
  cache.failures = 0;
  cache.retryAfter = 0;
  cache.lastError = null;
  cache.forceNext = false;
}

module.exports = {
  id: SOURCE,
  resetCache,
  forceRefresh,
  FRESH_MS,
  MIN_INTERVAL_MS,
  BACKOFF_RATE_LIMIT_MS,
  BACKOFF_TRANSIENT_MS,
  label: 'Claude — usage en direct',
  async: true,
  providesTokens: false,
  unavailableReason: "Connectez-vous avec `claude` pour que TRACE puisse lire votre usage réel.",
  isAvailable,
  collect,
  extractWindows,
  normalizeWindow,
};
