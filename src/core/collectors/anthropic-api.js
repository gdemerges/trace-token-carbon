'use strict';

/**
 * Collecteur API Anthropic — rapports d'usage et de coût de l'organisation.
 *
 * Contrairement aux collecteurs locaux, cette source donne la consommation
 * telle qu'ELLE EST FACTURÉE côté serveur : elle couvre tous les appareils et
 * toutes les clés de l'organisation, pas seulement cette machine. C'est la
 * référence quand les deux divergent.
 *
 * Nécessite une clé Admin (`sk-ant-admin...`) : une clé d'API normale est
 * rejetée. Ces endpoints ne sont pas exposés par les SDK, d'où l'appel HTTP
 * direct (fetch natif de Node, aucune dépendance).
 */

const SOURCE = 'anthropic-api';
const BASE = 'https://api.anthropic.com/v1/organizations';

function isAvailable(config = {}) {
  return !!config.anthropicAdminKey;
}

async function request(url, key) {
  const res = await fetch(url, {
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // On remonte un message exploitable : la cause n°1 est l'usage d'une clé
    // standard là où une clé Admin est requise.
    const hint =
      res.status === 401 || res.status === 403
        ? " — vérifiez qu'il s'agit bien d'une clé Admin (sk-ant-admin...)"
        : '';
    throw new Error(`Anthropic ${res.status}${hint}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Suit la pagination `has_more` / `next_page`, avec un garde-fou. */
async function paginate(baseUrl, params, key, maxPages = 40) {
  const out = [];
  let page = null;
  for (let i = 0; i < maxPages; i++) {
    const u = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
      else if (v != null) u.searchParams.set(k, v);
    }
    if (page) u.searchParams.set('page', page);
    const json = await request(u.toString(), key);
    out.push(...(json.data || []));
    if (!json.has_more || !json.next_page) break;
    page = json.next_page;
  }
  return out;
}

async function collect(config = {}) {
  const key = config.anthropicAdminKey;
  if (!key) return { events: [], quota: [], state: {}, stats: { configured: false, events: 0 } };

  const days = config.apiLookbackDays || 30;
  const endingAt = new Date();
  const startingAt = new Date(endingAt.getTime() - days * 86400000);

  const events = [];
  let cost = null;
  const errors = [];

  try {
    const buckets = await paginate(
      `${BASE}/usage_report/messages`,
      {
        starting_at: startingAt.toISOString(),
        ending_at: endingAt.toISOString(),
        bucket_width: '1d',
        'group_by[]': ['model', 'service_tier'],
        limit: 31,
      },
      key
    );

    for (const b of buckets) {
      const ts = Date.parse(b.starting_at || b.start_time) || Date.now();
      for (const r of b.results || []) {
        const cc = r.cache_creation || {};
        const w5 = cc.ephemeral_5m_input_tokens || 0;
        const w1 = cc.ephemeral_1h_input_tokens || 0;
        const cacheWrite = w5 + w1 || r.cache_creation_input_tokens || 0;
        const input = r.uncached_input_tokens != null ? r.uncached_input_tokens : r.input_tokens || 0;
        const output = r.output_tokens || 0;
        const cacheRead = r.cache_read_input_tokens || 0;
        if (!(input + output + cacheRead + cacheWrite)) continue;

        events.push({
          ts,
          source: SOURCE,
          model: r.model || 'unknown',
          project: r.workspace_id || null,
          session: null,
          tokens: {
            input,
            output,
            cacheRead,
            cacheWrite,
            cacheWrite5m: w5 || (w1 ? 0 : cacheWrite),
            cacheWrite1h: w1,
            thinking: 0,
            total: input + output + cacheRead + cacheWrite,
          },
          requests: r.num_requests || 1,
          authoritative: true, // chiffre facturé, prioritaire sur l'estimation locale
        });
      }
    }
  } catch (e) {
    errors.push(`usage: ${e.message}`);
  }

  try {
    const buckets = await paginate(
      `${BASE}/cost_report`,
      { starting_at: startingAt.toISOString(), ending_at: endingAt.toISOString(), limit: 31 },
      key
    );
    let total = 0;
    const byDay = {};
    for (const b of buckets) {
      const ts = Date.parse(b.starting_at || b.start_time);
      for (const r of b.results || []) {
        const amount = parseFloat(r.amount || 0);
        if (!Number.isFinite(amount)) continue;
        total += amount;
        if (Number.isFinite(ts)) {
          const d = new Date(ts).toISOString().slice(0, 10);
          byDay[d] = (byDay[d] || 0) + amount;
        }
      }
    }
    cost = { totalUSD: total, byDay };
  } catch (e) {
    errors.push(`cost: ${e.message}`);
  }

  return {
    events,
    quota: [],
    cost,
    state: {},
    stats: { configured: true, events: events.length, errors },
  };
}

module.exports = {
  id: SOURCE,
  label: 'API Anthropic (organisation)',
  async: true,
  requiresKey: 'anthropicAdminKey',
  unavailableReason: "Renseignez une clé Admin Anthropic (sk-ant-admin...) dans les réglages.",
  isAvailable,
  collect,
};
