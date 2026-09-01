'use strict';

const fs = require('fs');
const path = require('path');
const { homeDir } = require('../util');

/**
 * Collecteur Grok CLI — ACTIVITÉ SEULEMENT.
 *
 * Constat après inspection du poste, et non par principe :
 *
 *  - `~/.grok/logs/unified.jsonl` ne contient que des diagnostics applicatifs
 *    (état d'authentification, initialisation). Les rares lignes mentionnant
 *    « token » parlent du jeton d'auth, pas de consommation.
 *  - `~/.grok/sessions/session_search.sqlite` est un index de recherche
 *    plein-texte : identifiant de session, répertoire, titre, contenu. Aucun
 *    compteur.
 *  - Le binaire n'expose aucun endpoint d'usage ou de quota — contrairement à
 *    Claude Code, dont `/api/oauth/usage` permet le relevé en direct.
 *
 * Comme pour Gemini CLI et Ollama, on remonte donc l'activité et on déclare
 * `providesTokens: false`. Extrapoler un nombre de tokens depuis la longueur
 * des messages produirait un chiffre faux présenté comme une mesure.
 *
 * Les modèles Grok sont malgré tout déclarés dans le registre : le jour où une
 * source fournit des tokens — API xAI, ou version ultérieure du CLI — ils
 * seront correctement chiffrés.
 */

const SOURCE = 'grok-cli';

function rootDir(config = {}) {
  return config.grokDir || path.join(homeDir(), '.grok');
}

function isAvailable(config = {}) {
  try {
    return fs.statSync(path.join(rootDir(config), 'bin', 'grok')).isFile() || fs.statSync(rootDir(config)).isDirectory();
  } catch {
    return false;
  }
}

/** Lit l'index de sessions. Le module SQLite de Node est expérimental : son
 *  absence ou son échec ne doit jamais faire tomber le collecteur. */
function readSessions(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null; // runtime sans support SQLite
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT session_id, cwd, updated_at FROM session_docs').all();
    return rows;
  } catch {
    return null; // schéma inattendu ou base verrouillée
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* rien à faire */
    }
  }
}

function collect(config = {}) {
  const dir = rootDir(config);
  const activity = [];
  let sessions = 0;
  let lastActivity = null;

  const rows = readSessions(path.join(dir, 'sessions', 'session_search.sqlite'));
  if (rows) {
    sessions = rows.length;
    for (const r of rows) {
      // `updated_at` peut être en secondes ou en millisecondes selon la version.
      const raw = Number(r.updated_at);
      const ts = Number.isFinite(raw) ? (raw > 1e11 ? raw : raw * 1000) : null;
      if (!ts) continue;
      if (lastActivity == null || ts > lastActivity) lastActivity = ts;
      const d = new Date(ts);
      activity.push({
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        project: r.cwd ? path.basename(r.cwd) : null,
        prompts: 1,
        lastTs: ts,
      });
    }
  }

  return {
    events: [], // aucun token exploitable : on n'invente rien
    quota: [],
    activity,
    state: {},
    stats: { sessions, lastActivity, sqlite: rows != null },
  };
}

module.exports = {
  id: SOURCE,
  label: 'Grok CLI',
  providesTokens: false,
  unavailableReason:
    "Grok CLI ne journalise aucun compteur de tokens en local, et n'expose pas d'endpoint d'usage. Seule l'activité est remontée.",
  isAvailable,
  collect,
};
