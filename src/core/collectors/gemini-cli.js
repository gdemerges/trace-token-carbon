'use strict';

const fs = require('fs');
const path = require('path');
const { homeDir, projectName } = require('../util');

/**
 * Collecteur Gemini CLI — tokens réels, via sa télémétrie locale.
 *
 * Gemini CLI compte ses tokens depuis toujours, il ne les écrivait simplement
 * pas. Sa télémétrie OpenTelemetry en mode `local` les dépose dans un fichier,
 * sans rien envoyer à Google. Il suffit d'ajouter dans
 * `~/.gemini/settings.json` :
 *
 *     "telemetry": {
 *       "enabled": true,
 *       "target": "local",
 *       "outfile": "/chemin/vers/telemetry.log",
 *       "logPrompts": false
 *     }
 *
 * `logPrompts: false` est délibéré : on veut les compteurs, pas le contenu des
 * conversations écrit en clair sur le disque.
 *
 * Format observé : des objets JSON INDENTÉS et concaténés — pas du JSONL. Le
 * lecteur ci-dessous équilibre donc les accolades plutôt que de découper aux
 * sauts de ligne, et s'arrête au dernier objet complet : le fichier est écrit
 * pendant qu'on le lit.
 */

const SOURCE = 'gemini-cli';

function outfilePath(config = {}) {
  if (config.geminiTelemetryFile) return config.geminiTelemetryFile;
  // On lit le chemin déclaré par l'utilisateur dans les réglages de Gemini
  // plutôt que d'en imposer un.
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(homeDir(), '.gemini', 'settings.json'), 'utf8'));
    const t = settings.telemetry || {};
    if (t.enabled && t.outfile) return t.outfile.replace(/^~/, homeDir());
  } catch {
    /* réglages absents ou illisibles */
  }
  return path.join(homeDir(), '.gemini', 'telemetry.log');
}

/** Découpe une suite d'objets JSON concaténés, en ignorant les accolades
 *  situées dans des chaînes. Renvoie aussi l'offset de fin du dernier objet
 *  COMPLET, pour reprendre la lecture au bon endroit. */
function splitObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let consumed = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        consumed = i + 1;
        start = -1;
      }
    }
  }
  return { objects, consumed };
}

function isAvailable(config = {}) {
  try {
    return fs.statSync(outfilePath(config)).isFile();
  } catch {
    return false;
  }
}

function collect(config = {}, state = {}) {
  const file = outfilePath(config);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { events: [], quota: [], state: {}, stats: { events: 0, file: null } };
  }

  let offset = state.offset || 0;
  if (stat.size < offset) offset = 0; // fichier tronqué ou remplacé
  if (stat.size === offset) return { events: [], quota: [], state, stats: { events: 0, unchanged: true } };

  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const length = stat.size - offset;
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, offset);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }

  const { objects, consumed } = splitObjects(text);
  const events = [];
  let apiResponses = 0;

  for (const raw of objects) {
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      continue; // objet malformé : on le saute sans casser l'indexation
    }
    const a = rec.attributes || {};
    if (a['event.name'] !== 'gemini_cli.api_response') continue;
    apiResponses++;

    // Les compteurs sont sérialisés en chaîne par l'exporteur : on normalise.
    const num = (v) => {
      const n = typeof v === 'string' ? Number(v) : v;
      return Number.isFinite(n) ? n : 0;
    };
    const input = num(a.input_token_count);
    const output = num(a.output_token_count);
    const cacheRead = num(a.cached_content_token_count);
    const thinking = num(a.thoughts_token_count);
    if (!(input + output + cacheRead)) continue;

    const ts = Date.parse(a['event.timestamp']) || Date.now();
    events.push({
      ts,
      source: SOURCE,
      model: a.model || 'gemini',
      // `user.email` figure dans ces enregistrements : on ne le reprend nulle
      // part, ni dans l'index, ni dans l'interface.
      project: a.cwd ? projectName(a.cwd) : null,
      session: a['session.id'] || null,
      tokens: {
        input: Math.max(0, input - cacheRead), // l'entrée inclut le cache
        output,
        cacheRead,
        cacheWrite: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        thinking,
        total: input + output,
      },
      requests: 1,
    });
  }

  return {
    events,
    quota: [],
    state: { offset: offset + Buffer.byteLength(text.slice(0, consumed), 'utf8') },
    stats: { events: events.length, apiResponses, objects: objects.length },
  };
}

// --- Repli : activité seule, quand la télémétrie n'est pas activée --------
const { walkFiles } = require('../util');

function activityRoot(config = {}) {
  return config.geminiDir || path.join(homeDir(), '.gemini', 'tmp');
}

function collectActivity(config = {}, state = {}) {
  const files = walkFiles(activityRoot(config), (f) => f.endsWith('logs.json'));
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


/**
 * Point d'entrée unique pour Gemini.
 *
 * Avec la télémétrie locale activée, on remonte de vrais tokens. Sans elle,
 * on retombe sur l'activité — et on dit comment l'activer, plutôt que de
 * laisser croire que Gemini est inexploitable.
 */
function collectGemini(config = {}, state = {}) {
  if (isAvailable(config)) {
    const res = collect(config, state.telemetry || {});
    // Même avec la télémétrie, l'activité reste informative tant qu'aucun
    // appel n'a encore abouti.
    const act = collectActivity(config, state.activity || {});
    return {
      ...res,
      activity: act.activity,
      state: { telemetry: res.state, activity: act.state },
      stats: { ...res.stats, prompts: act.stats.prompts, telemetry: true },
    };
  }
  const act = collectActivity(config, state.activity || {});
  return { ...act, state: { activity: act.state }, stats: { ...act.stats, telemetry: false } };
}

module.exports = {
  id: SOURCE,
  label: 'Gemini CLI',
  // Vrai seulement si la télémétrie est active : l'interface doit pouvoir
  // distinguer « pas de tokens disponibles » de « tokens à zéro ».
  get providesTokens() {
    return isAvailable({});
  },
  isAvailable: () => true, // Gemini est traité dès que son dossier existe
  collect: collectGemini,
  collectTelemetry: collect,
  splitObjects,
  outfilePath,
  unavailableReason:
    "Aucun client Gemini n'écrit ses tokens en local. Le CLI historique le permettait via sa télémétrie, mais il n'est plus supporté ; Antigravity, qui le remplace, ne persiste ni compteurs ni quota. Seule l'activité est remontée.",
};
