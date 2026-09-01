'use strict';

/**
 * Collecteur API OpenAI — rapport d'usage de l'organisation.
 * Nécessite une clé Admin (`sk-admin-...`) ; une clé de projet est rejetée.
 */

const SOURCE = 'openai-api';
const BASE = 'https://api.openai.com/v1/organization';

function isAvailable(config = {}) {
  return !!config.openaiAdminKey;
}

async function request(url, key) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint =
      res.status === 401 || res.status === 403
        ? " — une clé Admin d'organisation (sk-admin-...) est requise"
        : '';
    throw new Error(`OpenAI ${res.status}${hint}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function collect(config = {}) {
  const key = config.openaiAdminKey;
  if (!key) return { events: [], quota: [], state: {}, stats: { configured: false, events: 0 } };

  const days = config.apiLookbackDays || 30;
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;

  const events = [];
  const errors = [];
  let page = null;

  try {
    for (let i = 0; i < 40; i++) {
      const u = new URL(`${BASE}/usage/completions`);
      u.searchParams.set('start_time', String(startTime));
      u.searchParams.set('end_time', String(endTime));
      u.searchParams.set('bucket_width', '1d');
      u.searchParams.append('group_by[]', 'model');
      u.searchParams.set('limit', '31');
      if (page) u.searchParams.set('page', page);

      const json = await request(u.toString(), key);
      for (const b of json.data || []) {
        const ts = (b.start_time || 0) * 1000 || Date.now();
        for (const r of b.results || []) {
          const cacheRead = r.input_cached_tokens || 0;
          // `input_tokens` inclut le cache : on isole la part réellement facturée plein tarif.
          const input = Math.max(0, (r.input_tokens || 0) - cacheRead);
          const output = r.output_tokens || 0;
          if (!(input + output + cacheRead)) continue;

          events.push({
            ts,
            source: SOURCE,
            model: r.model || 'unknown',
            project: r.project_id || null,
            session: null,
            tokens: {
              input,
              output,
              cacheRead,
              cacheWrite: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              thinking: 0,
              total: input + output + cacheRead,
            },
            requests: r.num_model_requests || 1,
            authoritative: true,
          });
        }
      }
      if (!json.has_more || !json.next_page) break;
      page = json.next_page;
    }
  } catch (e) {
    errors.push(e.message);
  }

  return { events, quota: [], state: {}, stats: { configured: true, events: events.length, errors } };
}

module.exports = {
  id: SOURCE,
  label: 'API OpenAI (organisation)',
  async: true,
  requiresKey: 'openaiAdminKey',
  unavailableReason: "Renseignez une clé Admin OpenAI (sk-admin-...) dans les réglages.",
  isAvailable,
  collect,
};
