'use strict';

/**
 * Collecteur Ollama — ÉTAT LIVE SEULEMENT.
 *
 * Ollama renvoie bien `prompt_eval_count` et `eval_count` dans la réponse de
 * chaque génération, mais ne les conserve nulle part : ses journaux
 * (~/.ollama/logs) n'en gardent aucune trace. Il n'existe donc pas
 * d'historique reconstituable après coup.
 *
 * Ce collecteur interroge l'API locale pour dire ce qui tourne maintenant et
 * ce qui est installé. Pour obtenir un historique, il faudrait interposer un
 * proxy sur le port 11434 — hors périmètre, et signalé comme tel dans l'UI.
 *
 * Note : un modèle local ne coûte rien en dollars mais consomme bien de
 * l'électricité, celle de la machine de l'utilisateur. Les modèles détectés
 * ici alimentent donc le registre avec leur taille réelle (lisible dans leur
 * nom), ce qui rend leur estimation carbone plus fiable que celle d'un modèle
 * fermé.
 */

const SOURCE = 'ollama';
const DEFAULT_HOST = 'http://127.0.0.1:11434';

async function probe(host, endpoint, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}${endpoint}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isAvailable(config = {}) {
  const host = config.ollamaHost || DEFAULT_HOST;
  return (await probe(host, '/api/tags')) != null;
}

async function collect(config = {}) {
  const host = config.ollamaHost || DEFAULT_HOST;
  const [tags, ps] = await Promise.all([probe(host, '/api/tags'), probe(host, '/api/ps')]);

  if (!tags) {
    return { events: [], quota: [], state: {}, stats: { available: false, events: 0 } };
  }

  const installed = (tags.models || []).map((m) => ({
    name: m.name,
    sizeBytes: m.size || 0,
    parameterSize: (m.details && m.details.parameter_size) || null,
    quantization: (m.details && m.details.quantization_level) || null,
  }));

  const running = (ps.models || []).map((m) => ({
    name: m.name,
    sizeBytes: m.size || 0,
    expiresAt: m.expires_at ? Date.parse(m.expires_at) : null,
  }));

  return {
    events: [],
    quota: [],
    live: { installed, running },
    state: {},
    stats: { available: true, events: 0, installed: installed.length, running: running.length },
  };
}

module.exports = {
  id: SOURCE,
  label: 'Ollama',
  providesTokens: false,
  async: true,
  unavailableReason:
    "Ollama ne conserve pas l'historique des tokens (les compteurs ne vivent que dans la réponse de chaque appel). Seul l'état courant est remonté.",
  isAvailable,
  collect,
};
