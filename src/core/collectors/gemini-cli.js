'use strict';

const path = require('path');
const fs = require('fs');
const { walkFiles, homeDir } = require('../util');

/**
 * Collecteur Gemini CLI — ACTIVITÉ SEULEMENT.
 *
 * Gemini CLI tient un `logs.json` par projet sous ~/.gemini/tmp/<hash>/, mais
 * n'y consigne que les messages de l'utilisateur : aucun compteur de tokens,
 * aucune information de modèle par requête. Il n'y a donc rien à en tirer
 * côté consommation.
 *
 * Plutôt que de fabriquer une estimation à partir du nombre de caractères — ce
 * qui produirait un chiffre faux présenté comme une mesure — ce collecteur
 * remonte uniquement le volume d'activité, et déclare `providesTokens: false`
 * pour que l'interface l'affiche comme tel.
 */

const SOURCE = 'gemini-cli';

function rootDir(config = {}) {
  return config.geminiDir || path.join(homeDir(), '.gemini', 'tmp');
}

function isAvailable(config = {}) {
  try {
    return fs.statSync(rootDir(config)).isDirectory();
  } catch {
    return false;
  }
}

function collect(config = {}, state = {}) {
  const files = walkFiles(rootDir(config), (f) => f.endsWith('logs.json'));
  const nextState = { files: {} };
  const activity = [];
  const sessions = new Set();

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const prev = (state.files && state.files[file]) || {};
    // Ce sont de petits fichiers JSON réécrits en entier : on se contente de
    // comparer taille et date pour éviter une relecture inutile.
    if (prev.size === stat.size && prev.mtimeMs === stat.mtimeMs && prev.entries) {
      nextState.files[file] = prev;
      for (const s of prev.sessionIds || []) sessions.add(s);
      activity.push(...(prev.days || []).map((d) => ({ ...d })));
      continue;
    }

    let records;
    try {
      records = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(records)) continue;

    const project = path.basename(path.dirname(file));
    const days = new Map();
    const sessionIds = new Set();
    for (const r of records) {
      if (!r || r.type !== 'user' || !r.timestamp) continue;
      const ts = Date.parse(r.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (r.sessionId) sessionIds.add(r.sessionId);
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const bucket = days.get(key) || { date: key, project, prompts: 0, lastTs: 0 };
      bucket.prompts++;
      bucket.lastTs = Math.max(bucket.lastTs, ts);
      days.set(key, bucket);
    }

    const dayList = [...days.values()];
    nextState.files[file] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      entries: records.length,
      sessionIds: [...sessionIds],
      days: dayList,
    };
    for (const s of sessionIds) sessions.add(s);
    activity.push(...dayList);
  }

  return {
    events: [], // aucun token exploitable : on n'invente rien
    quota: [],
    activity,
    state: nextState,
    stats: {
      files: files.length,
      events: 0,
      prompts: activity.reduce((n, d) => n + d.prompts, 0),
      sessions: sessions.size,
    },
  };
}

module.exports = {
  id: SOURCE,
  label: 'Gemini CLI',
  providesTokens: false,
  unavailableReason: "Gemini CLI ne journalise pas les tokens en local (uniquement les prompts). Seule l'activité est remontée.",
  isAvailable,
  collect,
};
