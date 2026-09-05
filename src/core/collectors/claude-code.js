'use strict';

const { t } = require('../../i18n');

const path = require('path');
const fs = require('fs');
const { walkFiles, readJsonlFrom, projectName, homeDir } = require('../util');

/**
 * Collecteur Claude Code : lit les fichiers .jsonl sous ~/.claude/projects.
 *
 * Chaque message d'assistant y porte un bloc `usage` complet, y compris la
 * ventilation du cache par TTL (`ephemeral_5m` / `ephemeral_1h`), ce qui
 * permet une tarification exacte plutôt qu'approchée.
 *
 * Deux pièges dans ce format, tous deux traités ici :
 *
 *  1. Un même message apparaît plusieurs fois — Claude Code réécrit la ligne
 *     au fil du streaming. Les doublons partagent `message.id`, et les
 *     compter deux fois doublerait purement et simplement la facture affichée.
 *  2. Les entrées `quotaLimits` (émises sur 429) portent l'état réel des
 *     limites de débit : type de fenêtre et instant de réinitialisation. C'est
 *     la seule source fiable sur le sujet, on la récupère au passage.
 */

const SOURCE = 'claude-code';

function rootDir(config = {}) {
  return config.claudeCodeDir || path.join(homeDir(), '.claude', 'projects');
}

function isAvailable(config = {}) {
  try {
    return fs.statSync(rootDir(config)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Classe la CAUSE réelle d'un refus.
 *
 * `rateLimitType` vaut toujours « five_hour » : il désigne la fenêtre dont on
 * rapporte l'heure de réinitialisation, PAS ce qui a bloqué la requête. Sur ce
 * poste, deux refus sur trois viennent en réalité d'un plafond de dépense
 * mensuel. Les confondre revient à calibrer la jauge 5 h sur un événement qui
 * n'a rien à voir avec elle.
 */
function rejectionCause(rec) {
  const text = (((rec.message || {}).content) || [])
    .map((c) => (typeof c === 'string' ? c : c.text || ''))
    .join(' ')
    .toLowerCase();

  if (/spend limit|spending limit|credit balance|out of credits/.test(text)) return 'spend';
  if (/weekly limit/.test(text)) return 'weekly';
  if (/session limit|usage limit|rate limit/.test(text)) return 'window';
  return 'unknown';
}

/** Convertit un bloc `usage` brut en structure de tokens canonique. */
function extractTokens(usage) {
  const cc = usage.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens || 0;
  const w1 = cc.ephemeral_1h_input_tokens || 0;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  // On préfère la ventilation par TTL quand elle est là ; `cache_creation_input_tokens`
  // sert de repli pour les versions de logs qui ne la fournissent pas.
  const cacheWrite = w5 + w1 || usage.cache_creation_input_tokens || 0;
  const thinking = (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite5m: w5 || (w1 ? 0 : cacheWrite),
    cacheWrite1h: w1,
    thinking,
    total: input + output + cacheRead + cacheWrite,
  };
}

/**
 * Scanne les fichiers de logs, en repartant de l'état d'indexation fourni.
 *
 * @param {object} state  index persistant : { files: { [path]: {size, offset, seen[]} } }
 * @returns {{events:Array, quota:Array, state:object, stats:object}}
 */
function collect(config = {}, state = {}) {
  const dir = rootDir(config);
  const files = walkFiles(dir, (f) => f.endsWith('.jsonl'));
  const nextState = { files: {} };
  const events = [];
  const quota = [];
  let skippedDuplicates = 0;

  for (const file of files) {
    const prev = (state.files && state.files[file]) || { offset: 0, seen: [] };
    // Fenêtre de déduplication : les réécritures de streaming sont adjacentes
    // dans le fichier, une fenêtre glissante bornée suffit et évite de garder
    // en mémoire l'intégralité des identifiants déjà vus.
    const seen = new Set(prev.seen || []);
    const order = [...(prev.seen || [])];

    const res = readJsonlFrom(file, prev.offset || 0, (rec) => {
      // --- état des limites de débit -------------------------------------
      if (rec.quotaLimits && rec.quotaLimits.resetsAt) {
        quota.push({
          source: SOURCE,
          ts: rec.timestamp ? Date.parse(rec.timestamp) : Date.now(),
          type: rec.quotaLimits.rateLimitType || 'unknown',
          status: rec.quotaLimits.status || null,
          resetsAt: rec.quotaLimits.resetsAt * 1000,
          usingOverage: !!rec.quotaLimits.isUsingOverage,
          cause: rejectionCause(rec),
        });
      }

      // --- consommation ---------------------------------------------------
      const msg = rec.message;
      if (!msg || msg.role !== 'assistant' || !msg.usage) return;

      const dedupKey = msg.id || rec.requestId;
      if (dedupKey) {
        if (seen.has(dedupKey)) {
          skippedDuplicates++;
          return;
        }
        seen.add(dedupKey);
        order.push(dedupKey);
        if (order.length > 500) seen.delete(order.shift());
      }

      const tokens = extractTokens(msg.usage);
      if (!tokens.total) return;

      events.push({
        ts: rec.timestamp ? Date.parse(rec.timestamp) : Date.now(),
        source: SOURCE,
        model: msg.model || 'unknown',
        project: projectName(rec.cwd),
        session: rec.sessionId || null,
        tokens,
        requests: 1,
      });
    });

    nextState.files[file] = { offset: res.offset, seen: order.slice(-500) };
  }

  return {
    events,
    quota,
    state: nextState,
    stats: { files: files.length, events: events.length, skippedDuplicates },
  };
}

module.exports = { id: SOURCE, get label() { return t('source.claude-code'); }, isAvailable, collect, extractTokens };
