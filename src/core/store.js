'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { emptyTokens, addTokens } = require('./util');

/**
 * Persistance : préférences utilisateur et index d'indexation incrémentale.
 *
 * Deux exigences ont dicté l'implémentation :
 *
 *  - Écriture atomique (fichier temporaire puis `rename`). Un rafraîchissement
 *    interrompu ne doit pas laisser un index tronqué qui ferait recompter
 *    l'historique depuis zéro — ou pire, en double.
 *  - Permissions restreintes (0600) sur la configuration, qui peut contenir
 *    des clés d'API Admin.
 */

function baseDir() {
  if (process.env.TRACE_HOME) return process.env.TRACE_HOME;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'TRACE');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TRACE');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'trace');
}

/**
 * Le dossier est en 0700, et pas seulement les fichiers qu'il contient.
 *
 * Sur macOS il hérite du 0700 posé par Electron, ce qui masquait le problème ;
 * sous Linux (`~/.config/trace`) le mode par défaut donne 0755, et l'index —
 * qui porte le nom de tous vos projets, vos identifiants de session et votre
 * volumétrie — devenait lisible par n'importe quel compte de la machine.
 */
function ensureDir() {
  const dir = baseDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    // Un dossier créé par une version antérieure garde son mode : on le
    // resserre au passage plutôt que d'attendre une réinstallation.
    fs.chmodSync(dir, 0o700);
  } catch {
    /* système de fichiers sans permissions POSIX (Windows) : sans objet */
  }
  return dir;
}

function writeAtomic(file, data, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const DEFAULT_CONFIG = {
  version: 1,
  // Sources
  disabledSources: [],
  anthropicAdminKey: null,
  openaiAdminKey: null,
  apiLookbackDays: 30,
  // Carbone
  carbon: { gridKey: 'us-average', localGridKey: 'france', pue: null },
  // Limites connues de l'utilisateur (en tokens pondérés) ; null => auto-calibrage
  limits: {},
  // Alertes
  alerts: { enabled: true, thresholds: [80, 95], projection: true },
  // Interface
  // 'auto' suit la langue du système ; 'fr' ou 'en' la forcent.
  locale: 'auto',
  shortcut: 'CommandOrControl+Alt+T',
  launchAtLogin: false,
  // Un appel à api.github.com au démarrage puis une fois par jour, pour savoir
  // si une version corrigée existe. Rien n'est téléchargé ni exécuté ; le
  // réglage à `false` supprime tout appel.
  checkUpdates: true,
  refreshIntervalSec: 60,
  trayMetric: 'session', // 'session' | 'tokens' | 'cost' | 'carbon'
  currency: 'USD',
  defaultRangeDays: 30,
  // Assez large pour ne jamais élaguer avant les outils eux-mêmes : Claude
  // Code purge ses sessions au bout de ~2 mois, Codex garde ses rollouts bien
  // plus longtemps. C'est la source qui doit limiter l'historique, pas TRACE.
  retentionDays: 1095,
  // Au-delà de cette ancienneté, les événements sont repliés en agrégats
  // horaires (voir `compact`). 0 ou null désactive la compaction.
  compactAfterDays: 90,
  modelOverrides: {},
};

function configPath() {
  return path.join(ensureDir(), 'config.json');
}
function indexPath() {
  return path.join(ensureDir(), 'index.json');
}

function loadConfig() {
  const stored = readJson(configPath(), {});
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    carbon: { ...DEFAULT_CONFIG.carbon, ...(stored.carbon || {}) },
    alerts: { ...DEFAULT_CONFIG.alerts, ...(stored.alerts || {}) },
    limits: { ...DEFAULT_CONFIG.limits, ...(stored.limits || {}) },
  };
}

function saveConfig(config) {
  // 0600 : la configuration peut contenir des clés Admin.
  writeAtomic(configPath(), JSON.stringify(config, null, 2), 0o600);
  return config;
}

// ---------------------------------------------------------------------------
// Propriété de l'index
// ---------------------------------------------------------------------------

/**
 * Un seul processus écrit l'index à la fois.
 *
 * L'application et la CLI partagent le même fichier, et toutes deux le
 * relisent, le complètent, puis le réécrivent en entier. Lancer `trace`
 * pendant que l'application tourne faisait donc s'écraser mutuellement les
 * offsets des collecteurs : la déduplication protégeait les chiffres, mais
 * chaque processus repartait ensuite en relecture complète des journaux.
 *
 * Un verrou par fichier ne suffirait pas : la fenêtre à protéger n'est pas
 * l'écriture (atomique, quelques millisecondes) mais tout le cycle
 * lecture → collecte → écriture. On désigne donc un propriétaire, qui
 * rafraîchit sa marque à chaque cycle. Les autres processus lisent l'index
 * mais ne l'écrivent pas — ils affichent des chiffres justes sans rien
 * dégrader.
 */
const OWNER_STALE_MS = 5 * 60 * 1000;

function ownerPath() {
  return path.join(ensureDir(), 'owner.json');
}

/** Se déclare propriétaire de l'index. L'application appelle ceci à chaque cycle. */
function claimOwnership(now = Date.now()) {
  try {
    writeAtomic(ownerPath(), JSON.stringify({ pid: process.pid, at: now }), 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Vrai si un AUTRE processus vivant tient l'index. */
function ownedByAnother(now = Date.now()) {
  const owner = readJson(ownerPath(), null);
  if (!owner || typeof owner.pid !== 'number') return false;
  if (owner.pid === process.pid) return false;
  // Marque périmée : le propriétaire a été tué sans relâcher. On ne va pas
  // condamner l'index pour autant.
  if (!(now - (owner.at || 0) < OWNER_STALE_MS)) return false;
  try {
    // Signal 0 : ne tue rien, vérifie seulement que le processus existe.
    process.kill(owner.pid, 0);
    return true;
  } catch (e) {
    // EPERM : le processus existe mais appartient à un autre utilisateur.
    return e.code === 'EPERM';
  }
}

/** Relâche la marque, si elle nous appartient. */
function releaseOwnership() {
  const owner = readJson(ownerPath(), null);
  if (owner && owner.pid === process.pid) {
    try {
      fs.unlinkSync(ownerPath());
    } catch {
      /* déjà parti */
    }
  }
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Replie les événements anciens en agrégats HORAIRES.
 *
 * L'index conserve un enregistrement par requête sur toute la rétention — trois
 * ans par défaut. Or au-delà de quelques semaines, plus aucune vue ne consomme
 * la requête unitaire : la série journalière, l'histogramme horaire, les
 * ventilations par modèle et par projet passent toutes par une agrégation.
 * Garder le détail revient à relire et réécrire des dizaines de mégaoctets
 * pour une information que personne ne regarde.
 *
 * Pourquoi l'HEURE et non le jour : mesuré sur un index réel, replier à
 * l'heure divise le volume par 46, replier au jour par 98. Le facteur deux
 * gagné coûterait l'histogramme horaire — la vue qui montre les rythmes de
 * travail — et la précision de la série journalière aux frontières de fuseau.
 * L'heure garde tous les graphes exacts.
 *
 * Ce qui est perdu, et assumé : la session. Un agrégat horaire recouvre
 * plusieurs sessions, on n'en retient donc aucune plutôt que d'en inventer
 * une. Le classement des sessions ne porte que sur la période récente — ce qui
 * est de toute façon le seul horizon où il veut dire quelque chose.
 */
function compact(events, options = {}) {
  const now = options.now || Date.now();
  const days = options.olderThanDays;
  if (!Number.isFinite(days) || days <= 0) return { events, compactedThrough: options.compactedThrough || 0, folded: 0 };

  const cutoff = now - days * 86400000;
  const recent = [];
  const buckets = new Map();
  let folded = 0;

  for (const e of events) {
    // Un agrégat journalier est déjà replié : le repasser à la moulinette
    // horaire le déplacerait à minuit sans rien gagner.
    if (e.ts >= cutoff || e.compacted === 'day') {
      recent.push(e);
      continue;
    }
    const d = new Date(e.ts);
    d.setMinutes(0, 0, 0);
    const hour = d.getTime();
    const key = `${hour}\u0000${e.source}\u0000${e.model}\u0000${e.project || ''}`;

    let b = buckets.get(key);
    if (!b) {
      buckets.set(key, (b = {
        ts: hour,
        source: e.source,
        model: e.model,
        project: e.project || null,
        session: null,
        tokens: emptyTokens(),
        requests: 0,
        compacted: 'hour',
      }));
    } else {
      folded++;
    }
    addTokens(b.tokens, e.tokens);
    b.requests += e.requests || 1;
  }

  const compacted = [...buckets.values()];
  const all = compacted.length ? compacted.concat(recent).sort((a, b) => a.ts - b.ts) : recent;
  return { events: all, compactedThrough: cutoff, folded };
}

function loadIndex(config = {}) {
  const idx = readJson(indexPath(), null);
  if (!idx || idx.version !== 2) return { version: 2, collectors: {}, events: [], quota: [] };

  // Rétention élargie : l'historique élagué ne reviendra pas tout seul, les
  // collecteurs reprenant leur lecture à un offset. On remet les offsets à
  // zéro pour forcer une relecture complète — 380 ms sur 116 Mo, c'est indolore.
  const want = Number.isFinite(config.retentionDays) ? config.retentionDays : DEFAULT_CONFIG.retentionDays;
  if ((idx.retentionDays || 0) < want) {
    return {
      version: 2,
      collectors: {},
      events: idx.events || [],
      quota: idx.quota || [],
      // La relecture complète repasserait sur des périodes déjà repliées : la
      // borne de compaction voyage avec l'index pour que la fusion sache
      // écarter ce détail redevenu inutile.
      compactedThrough: idx.compactedThrough || 0,
      reindexed: true,
    };
  }
  return idx;
}

/**
 * L'index conserve les événements pour ne pas relire l'historique complet à
 * chaque démarrage. On borne la rétention : au-delà, le fichier grossirait
 * indéfiniment alors que le tableau de bord ne regarde jamais si loin.
 */
/**
 * Signature bon marché de l'état persistable.
 *
 * L'index était réécrit à chaque cycle de 60 s même sans le moindre nouvel
 * événement : 2 Mo × 1440 = près de 3 Go écrits par jour pour une application
 * au repos. Ce n'est pas un problème de vitesse — 2,5 ms — mais d'usure du
 * disque et d'E/S sans objet.
 */
function indexSignature(idx, retentionDays) {
  const last = (arr) => (arr && arr.length ? arr[arr.length - 1].ts : 0);
  return [
    retentionDays,
    (idx.events || []).length,
    last(idx.events),
    (idx.quota || []).length,
    last(idx.quota),
    idx.compactedThrough || 0,
    // Les offsets des collecteurs changent dès qu'un fichier grossit, même si
    // aucune ligne exploitable n'en sort.
    JSON.stringify(idx.collectors || {}).length,
  ].join('|');
}

let lastSignature = null;

/**
 * Élague, replie, puis écrit — si nous sommes bien le processus qui écrit.
 *
 * @param {object} idx     index à persister
 * @param {object|number} options  configuration, ou rétention en jours (forme
 *        historique, conservée pour les appels existants)
 * @returns {object} l'index RETENU : c'est lui, et pas celui d'avant élagage,
 *          que l'appelant doit garder en mémoire, sous peine de voir la vue et
 *          le fichier diverger au prochain démarrage.
 */
function saveIndex(idx, options = {}) {
  const config = typeof options === 'number' ? { retentionDays: options } : options || {};
  const retentionDays = Number.isFinite(config.retentionDays) ? config.retentionDays : DEFAULT_CONFIG.retentionDays;
  const compactAfterDays = Number.isFinite(config.compactAfterDays) ? config.compactAfterDays : DEFAULT_CONFIG.compactAfterDays;

  const now = Date.now();
  const cutoff = now - retentionDays * 86400000;
  const kept = (idx.events || []).filter((e) => e.ts >= cutoff);
  const folded = compact(kept, { olderThanDays: compactAfterDays, now });

  const trimmed = {
    version: 2,
    updatedAt: now,
    // Mémorisée pour détecter un élargissement : les événements déjà élagués
    // ne reviendraient pas d'eux-mêmes, il faut relire les sources.
    retentionDays,
    compactAfterDays,
    // Frontière du détail : en deçà, l'index ne porte plus que des agrégats
    // horaires, et toute requête unitaire relue à nouveau doit être ignorée.
    compactedThrough: Math.max(idx.compactedThrough || 0, folded.compactedThrough || 0),
    collectors: idx.collectors || {},
    events: folded.events,
    quota: (idx.quota || []).filter((q) => q.ts >= cutoff),
  };

  const signature = indexSignature(trimmed, retentionDays);
  if (signature === lastSignature) return trimmed; // rien n'a bougé
  // Un autre processus tient l'index : on lui laisse la main. Nos chiffres
  // restent justes en mémoire, on cesse simplement de réécrire par-dessus lui.
  if (config.readOnly || ownedByAnother(now)) return trimmed;
  // 0600 comme la configuration : l'index porte l'historique d'usage, les
  // noms de projets et les identifiants de session.
  writeAtomic(indexPath(), JSON.stringify(trimmed), 0o600);
  lastSignature = signature;
  return trimmed;
}

/** Réservé aux tests : la signature est un cache de processus. */
function resetSignature() {
  lastSignature = null;
}

module.exports = {
  baseDir,
  loadConfig,
  saveConfig,
  loadIndex,
  saveIndex,
  compact,
  claimOwnership,
  ownedByAnother,
  releaseOwnership,
  resetSignature,
  DEFAULT_CONFIG,
  configPath,
  indexPath,
  ownerPath,
  indexSignature,
  OWNER_STALE_MS,
};
