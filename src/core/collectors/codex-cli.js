'use strict';

const path = require('path');
const fs = require('fs');
const { walkFiles, readJsonlFrom, projectName, homeDir } = require('../util');

/**
 * Collecteur Codex CLI / Codex Desktop : lit les « rollouts » sous
 * ~/.codex/sessions et ~/.codex/archived_sessions.
 *
 * Piège central du format : chaque événement `token_count` porte DEUX
 * compteurs, `total_token_usage` (cumulé depuis le début de la session) et
 * `last_token_usage` (le tour qui vient de s'écouler). Sommer le premier
 * multiplierait la consommation par le nombre de tours de la session. On
 * n'utilise donc que le second.
 *
 * Bon côté : ces événements embarquent aussi `rate_limits`, avec un
 * pourcentage d'utilisation déjà calculé côté serveur et la taille de la
 * fenêtre — bien plus fiable que tout ce qu'on pourrait reconstruire.
 */

const SOURCE = 'codex-cli';

function rootDirs(config = {}) {
  const base = config.codexDir || path.join(homeDir(), '.codex');
  return [path.join(base, 'sessions'), path.join(base, 'archived_sessions')];
}

function isAvailable(config = {}) {
  return rootDirs(config).some((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

function collect(config = {}, state = {}) {
  const files = [];
  for (const dir of rootDirs(config)) files.push(...walkFiles(dir, (f) => /rollout-.*\.jsonl$/.test(f)));

  const nextState = { files: {} };
  const events = [];
  const quota = [];

  for (const file of files) {
    const prev = (state.files && state.files[file]) || { offset: 0 };
    // Le modèle et le répertoire de travail arrivent dans `session_meta`, en
    // tête de fichier. En lecture incrémentale on ne les reverra pas : on les
    // mémorise donc dans l'état d'indexation.
    let model = prev.model || 'codex';
    let project = prev.project || null;
    let session = prev.session || null;

    const res = readJsonlFrom(file, prev.offset || 0, (rec) => {
      const p = rec.payload;
      if (!p) return;

      if (rec.type === 'session_meta' || p.type === 'session_meta') {
        if (p.model) model = p.model;
        if (p.cwd) project = projectName(p.cwd);
        if (p.session_id) session = p.session_id;
        return;
      }
      if (p.type === 'turn_context' && p.model) {
        model = p.model;
        return;
      }
      if (p.type !== 'token_count' || !p.info) return;

      // --- limites de débit, déjà calculées par le serveur -----------------
      const rl = p.rate_limits;
      if (rl) {
        const ts = rec.timestamp ? Date.parse(rec.timestamp) : Date.now();
        for (const key of ['primary', 'secondary']) {
          const w = rl[key];
          if (!w || w.used_percent == null) continue;
          quota.push({
            source: SOURCE,
            ts,
            type: w.window_minutes ? `${w.window_minutes}min` : key,
            windowMinutes: w.window_minutes || null,
            usedPercent: w.used_percent,
            resetsAt: w.resets_at ? w.resets_at * 1000 : null,
            plan: rl.plan_type || null,
            status: rl.rate_limit_reached_type ? 'rejected' : 'ok',
          });
        }
      }

      // --- consommation du tour --------------------------------------------
      const u = p.info.last_token_usage;
      if (!u) return;
      const cacheRead = u.cached_input_tokens || 0;
      const cacheWrite = u.cache_write_input_tokens || 0;
      // `input_tokens` inclut déjà les tokens servis par le cache : on les
      // retranche pour ne pas les facturer deux fois, une fois au tarif plein
      // et une fois au tarif cache.
      const input = Math.max(0, (u.input_tokens || 0) - cacheRead - cacheWrite);
      const output = u.output_tokens || 0;
      if (!(input + output + cacheRead + cacheWrite)) return;

      events.push({
        ts: rec.timestamp ? Date.parse(rec.timestamp) : Date.now(),
        source: SOURCE,
        model,
        project,
        session,
        tokens: {
          input,
          output,
          cacheRead,
          cacheWrite,
          cacheWrite5m: cacheWrite,
          cacheWrite1h: 0,
          thinking: u.reasoning_output_tokens || 0,
          total: input + output + cacheRead + cacheWrite,
        },
        requests: 1,
      });
    });

    nextState.files[file] = { offset: res.offset, model, project, session };
  }

  return { events, quota, state: nextState, stats: { files: files.length, events: events.length } };
}

module.exports = { id: SOURCE, label: 'Codex CLI', isAvailable, collect };
