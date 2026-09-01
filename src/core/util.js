'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Clé de jour locale `YYYY-MM-DD` (et non UTC : l'utilisateur raisonne en jours locaux). */
function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Somme de tokens, structure canonique unique dans toute l'application. */
function emptyTokens() {
  return { input: 0, output: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, thinking: 0, total: 0 };
}

function addTokens(acc, t) {
  acc.input += t.input || 0;
  acc.output += t.output || 0;
  acc.cacheWrite += t.cacheWrite || 0;
  acc.cacheWrite5m += t.cacheWrite5m || 0;
  acc.cacheWrite1h += t.cacheWrite1h || 0;
  acc.cacheRead += t.cacheRead || 0;
  acc.thinking += t.thinking || 0;
  acc.total += t.total || 0;
  return acc;
}

/** Parcours récursif, tolérant aux permissions refusées et aux liens cassés. */
function walkFiles(dir, filter, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) walkFiles(full, filter, out, depth + 1);
      else if (e.isFile() && filter(full)) out.push(full);
    } catch {
      /* fichier disparu en cours de route : on ignore */
    }
  }
  return out;
}

/**
 * Lit un fichier JSONL à partir d'un offset en octets et n'appelle `onRecord`
 * que sur les lignes complètes. Renvoie le nouvel offset, positionné au début
 * de la dernière ligne incomplète — indispensable, car Claude Code écrit dans
 * ces fichiers pendant qu'on les lit.
 */
function readJsonlFrom(file, offset, onRecord) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { offset, ok: false };
  }
  // Fichier tronqué ou remplacé : on repart du début.
  if (stat.size < offset) offset = 0;
  if (stat.size === offset) return { offset, ok: true, unchanged: true };

  const fd = fs.openSync(file, 'r');
  try {
    const length = stat.size - offset;
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, offset);
    const text = buf.toString('utf8');

    let start = 0;
    let consumed = 0;
    while (true) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) break;
      const line = text.slice(start, nl);
      consumed = nl + 1;
      start = nl + 1;
      if (!line.trim()) continue;
      try {
        onRecord(JSON.parse(line));
      } catch {
        /* ligne corrompue ou partielle : on la saute sans casser l'indexation */
      }
    }
    return { offset: offset + Buffer.byteLength(text.slice(0, consumed), 'utf8'), ok: true };
  } finally {
    fs.closeSync(fd);
  }
}

/** Nom de projet lisible à partir d'un chemin de travail. */
function projectName(cwd) {
  if (!cwd) return null;
  const base = path.basename(cwd);
  return base || cwd;
}

function homeDir() {
  return os.homedir();
}

/** Fenêtre glissante : borne inférieure en ms pour `hours` heures en arrière. */
function since(hours, now = Date.now()) {
  return now - hours * 3600 * 1000;
}

module.exports = { dayKey, emptyTokens, addTokens, walkFiles, readJsonlFrom, projectName, homeDir, since };
