'use strict';

const claudeCode = require('./claude-code');
const codexCli = require('./codex-cli');
const geminiCli = require('./gemini-cli');
const ollama = require('./ollama');
const anthropicOauth = require('./anthropic-oauth');
const anthropicApi = require('./anthropic-api');
const openaiApi = require('./openai-api');

const ALL = [claudeCode, anthropicOauth, codexCli, geminiCli, ollama, anthropicApi, openaiApi];

/**
 * Exécute tous les collecteurs activés et fusionne leurs résultats.
 *
 * Chaque collecteur est isolé : celui qui échoue est signalé dans `sources`
 * mais n'empêche jamais les autres de remonter leurs données. Un dossier de
 * logs corrompu ne doit pas vider tout le tableau de bord.
 *
 * @param {object} config  préférences utilisateur (clés API, chemins, sources désactivées)
 * @param {object} state   index persistant, par identifiant de collecteur
 */
async function collectAll(config = {}, state = {}) {
  const disabled = new Set(config.disabledSources || []);
  const events = [];
  const quota = [];
  const nextState = {};
  const sources = [];
  const extra = {};

  await Promise.all(
    ALL.map(async (c) => {
      const entry = {
        id: c.id,
        label: c.label,
        providesTokens: c.providesTokens !== false,
        enabled: !disabled.has(c.id),
        available: false,
        events: 0,
        error: null,
        note: null,
      };

      try {
        if (!entry.enabled) {
          entry.note = 'Désactivée dans les réglages';
          return;
        }
        entry.available = await Promise.resolve(c.isAvailable(config));
        if (!entry.available) {
          entry.note = c.unavailableReason || 'Source introuvable sur cette machine';
          return;
        }

        const res = await Promise.resolve(c.collect(config, state[c.id] || {}));
        if (res.events && res.events.length) events.push(...res.events);
        if (res.quota && res.quota.length) quota.push(...res.quota);
        if (res.state) nextState[c.id] = res.state;
        if (res.live) extra[c.id] = { ...(extra[c.id] || {}), live: res.live };
        if (res.activity) extra[c.id] = { ...(extra[c.id] || {}), activity: res.activity };
        if (res.cost) extra[c.id] = { ...(extra[c.id] || {}), cost: res.cost };

        entry.events = (res.events || []).length;
        // Certaines sources ne remontent pas de tokens mais des fenêtres de
        // quota : les compter permet de dire qu'elles fonctionnent, au lieu
        // de leur coller un message d'indisponibilité par défaut.
        entry.quota = (res.quota || []).length;
        entry.stats = res.stats || {};
        if (res.stats && res.stats.errors && res.stats.errors.length) entry.error = res.stats.errors.join(' ; ');
        // Le motif d'indisponibilité ne s'affiche que si la source n'a
        // effectivement rien produit — « connectez-vous » sous une source qui
        // vient de répondre est un contresens.
        if (c.providesTokens === false && !entry.events && !entry.quota) entry.note = c.unavailableReason;
      } catch (e) {
        entry.error = e && e.message ? e.message : String(e);
      } finally {
        sources.push(entry);
      }
    })
  );

  // Les collecteurs tournent en parallèle : on rétablit un ordre stable pour
  // que l'interface ne réordonne pas ses lignes d'un rafraîchissement à l'autre.
  const order = ALL.map((c) => c.id);
  sources.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  events.sort((a, b) => a.ts - b.ts);

  return { events, quota, sources, extra, state: nextState };
}

module.exports = { collectAll, ALL };
