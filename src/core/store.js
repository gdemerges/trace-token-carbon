'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

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

function ensureDir() {
  const dir = baseDir();
  fs.mkdirSync(dir, { recursive: true });
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
  // Interface
  shortcut: 'CommandOrControl+Alt+T',
  launchAtLogin: false,
  refreshIntervalSec: 60,
  trayMetric: 'session', // 'session' | 'tokens' | 'cost' | 'carbon'
  currency: 'USD',
  defaultRangeDays: 30,
  retentionDays: 365,
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
    limits: { ...DEFAULT_CONFIG.limits, ...(stored.limits || {}) },
  };
}

function saveConfig(config) {
  // 0600 : la configuration peut contenir des clés Admin.
  writeAtomic(configPath(), JSON.stringify(config, null, 2), 0o600);
  return config;
}

function loadIndex() {
  const idx = readJson(indexPath(), null);
  if (!idx || idx.version !== 2) return { version: 2, collectors: {}, events: [], quota: [] };
  return idx;
}

/**
 * L'index conserve les événements pour ne pas relire l'historique complet à
 * chaque démarrage. On borne la rétention : au-delà, le fichier grossirait
 * indéfiniment alors que le tableau de bord ne regarde jamais si loin.
 */
function saveIndex(idx, retentionDays) {
  if (!Number.isFinite(retentionDays)) retentionDays = DEFAULT_CONFIG.retentionDays;
  const cutoff = Date.now() - retentionDays * 86400000;
  const trimmed = {
    version: 2,
    updatedAt: Date.now(),
    collectors: idx.collectors || {},
    events: (idx.events || []).filter((e) => e.ts >= cutoff),
    quota: (idx.quota || []).filter((q) => q.ts >= cutoff),
  };
  writeAtomic(indexPath(), JSON.stringify(trimmed));
  return trimmed;
}

module.exports = { baseDir, loadConfig, saveConfig, loadIndex, saveIndex, DEFAULT_CONFIG, configPath, indexPath };
