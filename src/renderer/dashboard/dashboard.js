import { nf, tokens, usd, co2, energy, pct, windowLabel, ago, shortDate, esc } from '../shared/format.js';
import { traceStrip, gauge, bars, rangeBar } from '../shared/charts.js';
import { providerMark, PROVIDER_LABEL } from '../shared/marks.js';

const $ = (s) => document.querySelector(s);

let snap = null;
let days = 30;
let metric = 'tokens'; // grandeur affichée dans l'histogramme journalier

// ---------------------------------------------------------------------------
// Héros
// ---------------------------------------------------------------------------

function trendChip(value, significant, inverse = true) {
  if (value == null || !significant) return '<span class="trend faint">—</span>';
  const up = value > 0;
  // Consommer plus n'est pas une bonne nouvelle : la hausse est signalée en
  // chaud, la baisse en neutre. La couleur ne félicite pas la croissance.
  const cls = up && inverse ? 'c-hot' : 'faint';
  return `<span class="trend ${cls}">${up ? '▲' : '▼'} ${nf(Math.abs(value), 0)} %</span>`;
}

function renderHero() {
  const t = snap.report.totals;
  const tr = snap.report.trend;
  const c = t.carbon.gramsCO2e;

  $('#figures').innerHTML = `
    <div class="fig"><div class="legend">Tokens</div>
      <div class="v num c-tokens">${tokens(t.tokens.total)}</div>
      <div class="x faint num">${nf(t.requests)} requêtes${tr.significant ? ` · ${trendChip(tr.tokens, tr.significant)}` : ''}</div></div>
    <div class="fig"><div class="legend">Coût estimé</div>
      <div class="v num c-cost">${usd(t.costUSD)}</div>
      <div class="x faint num">${usd(t.cacheSavingsUSD)} évités par le cache${tr.significant ? ` · ${trendChip(tr.cost, tr.significant)}` : ''}</div></div>
    <div class="fig"><div class="legend">Empreinte CO₂e</div>
      <div class="v num c-carbon">${co2(c.mid)}</div>
      <div class="x faint num">${co2(c.min)} – ${co2(c.max)}${tr.significant ? ` · ${trendChip(tr.carbon, tr.significant)}` : ''}</div></div>
    <div class="fig"><div class="legend">Énergie</div>
      <div class="v num">${energy(t.carbon.energyWh.mid)}</div>
      <div class="x faint num">${energy(t.carbon.energyWh.min)} – ${energy(t.carbon.energyWh.max)}</div></div>`;

  requestAnimationFrame(() =>
    traceStrip($('#hero-strip'), snap.report.daily, { label: 'Tokens consommés par jour' })
  );
}

// ---------------------------------------------------------------------------
// Panneaux
// ---------------------------------------------------------------------------

function card(cls, title, aside = '') {
  const s = document.createElement('section');
  s.className = `card panel ${cls}`;
  s.innerHTML = `<h2>${esc(title)}${aside ? `<span class="aside faint">${aside}</span>` : ''}</h2>`;
  return s;
}

function gaugesCard() {
  const s = card('span-5', 'Limites de débit');
  const wrap = document.createElement('div');
  wrap.className = 'gauges';

  if (!snap.gauges.length) {
    wrap.innerHTML = '<div class="note">Aucune fenêtre de limitation détectée pour le moment.</div>';
  }

  for (const g of snap.gauges) {
    const row = document.createElement('div');
    row.className = 'gauge-row';
    const origin = {
      live: 'relevé en direct auprès d’Anthropic',
      'live-stale': `dernier relevé Anthropic ${g.reportedAt ? ago(g.reportedAt) : ''} — reprise en cours`,
      derived: 'déduit du dernier relevé du fournisseur',
      reset: 'fenêtre réinitialisée, aucune activité depuis',
      provider: 'communiqué par le fournisseur',
      user: g.calibratedAt ? `calé sur votre relevé du ${new Date(g.calibratedAt).toLocaleDateString('fr-FR')}` : 'calé sur votre relevé',
      observed: 'estimé d’après un refus passé — approximatif',
      configured: 'plafond que vous avez renseigné',
    }[g.limitSource] || 'échelle inconnue — cliquez sur « ajuster »';

    // Le « ≈ » n'est pas cosmétique : une échelle déduite d'un refus peut
    // s'écarter d'un facteur deux ou trois du plafond réel.
    // Sans échelle fiable, on n'invente pas de pourcentage : on montre ce
    // qu'on sait vraiment, la consommation pondérée de la fenêtre.
    const shown = g.percent == null
      ? `<span class="faint num" style="font-size:12px">${tokens(g.used)} consommés</span>`
      : `${g.approximate ? '≈ ' : ''}${pct(g.percent)}`;

    row.innerHTML = `<div class="top">
        ${providerMark(g.provider, 12)}<span class="legend">${esc(g.label)}</span>
        ${g.calibratable ? '<button class="calib" type="button">ajuster</button>' : ''}
        <span class="val num ${g.percent >= 85 ? 'c-hot' : ''}${g.approximate ? ' faint' : ''}">${shown}</span>
      </div><div class="bar"></div>
      <div class="meta faint"><span${g.stale ? ' class="c-hot"' : ''}>${esc(windowLabel(g))}</span>
        <span class="r">${esc(origin)}</span></div>`;
    wrap.appendChild(row);
    requestAnimationFrame(() => gauge(row.querySelector('.bar'), g.percent, { height: 10, approximate: g.approximate }));

    const calibBtn = row.querySelector('.calib');
    if (calibBtn) calibBtn.onclick = () => openCalibration(row, g);
  }
  s.appendChild(wrap);
  return s;
}

/**
 * Saisie du pourcentage réel.
 *
 * Le vrai taux d'occupation d'une fenêtre Claude n'existe nulle part en local :
 * `/usage` l'obtient en interrogeant l'API. TRACE ne peut donc que l'estimer —
 * sauf si l'utilisateur le lui dit. On remonte alors au plafond par produit en
 * croix, et toutes les lectures suivantes deviennent exactes.
 */
function openCalibration(row, g) {
  if (row.querySelector('.calib-form')) return;
  const form = document.createElement('form');
  form.className = 'calib-form';
  form.innerHTML = `<span class="faint">Tapez <code>/usage</code> dans Claude Code, puis reportez le pourcentage réel :</span>
    <span class="calib-input"><input type="number" min="1" max="100" step="1" required placeholder="72" aria-label="Pourcentage réel" /> %</span>
    <button class="btn primary" type="submit">Caler</button>
    <button class="btn" type="button" data-cancel>Annuler</button>
    <span class="calib-msg"></span>`;
  row.appendChild(form);
  form.querySelector('input').focus();

  form.querySelector('[data-cancel]').onclick = () => form.remove();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const value = Number(form.querySelector('input').value);
    const msg = form.querySelector('.calib-msg');
    const res = await window.trace.calibrate(g.id, value);
    if (res.ok) form.remove();
    else { msg.textContent = res.error; msg.className = 'calib-msg c-hot'; }
  };
}

function dailyCard() {
  const s = card('span-7', 'Consommation par jour');
  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.style.cssText = 'margin-left:auto';
  for (const [k, label] of [['tokens', 'Tokens'], ['cost', 'Coût'], ['carbon', 'CO₂e']]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(metric === k));
    b.onclick = () => { metric = k; render(); };
    seg.appendChild(b);
  }
  s.querySelector('h2').appendChild(seg);

  const host = document.createElement('div');
  host.style.height = '132px';
  s.appendChild(host);

  const axis = document.createElement('div');
  axis.className = 'faint num';
  axis.style.cssText = 'display:flex;justify-content:space-between;font-size:9.5px;margin-top:6px';
  const d = snap.report.daily;
  if (d.length) {
    axis.innerHTML = `<span>${shortDate(d[0].date)}</span><span>${shortDate(d[Math.floor(d.length / 2)].date)}</span><span>${shortDate(d[d.length - 1].date)}</span>`;
  }
  s.appendChild(axis);

  const pick = { tokens: (x) => x.tokens.total, cost: (x) => x.costUSD, carbon: (x) => x.gramsCO2e }[metric];
  const fmt = { tokens, cost: usd, carbon: co2 }[metric];
  const color = { tokens: 'var(--tokens)', cost: 'var(--cost)', carbon: 'var(--carbon)' }[metric];

  requestAnimationFrame(() =>
    bars(host, snap.report.daily.map((x) => ({
      value: pick(x),
      color,
      title: `${x.date} — ${fmt(pick(x))}`,
    })), { height: 132 })
  );
  return s;
}

function modelsCard() {
  const s = card('span-7', 'Par modèle');
  const total = snap.report.totals.tokens.total || 1;
  const rows = snap.report.byModel.map((g) => {
    const m = g.models[0];
    const share = (g.tokens.total / total) * 100;
    return `<tr>
      <td><div class="name-cell" title="${esc(PROVIDER_LABEL[m.provider] || m.provider)}">${providerMark(m.provider)}<span>${esc(m.label)}</span></div></td>
      <td class="num">${tokens(g.tokens.total)}</td>
      <td class="num faint">${share < 0.1 ? '<0,1 %' : pct(share, share < 10 ? 1 : 0)}</td>
      <td class="num">${nf(g.requests)}</td>
      <td class="num c-cost">${g.costUnknown ? '—' : usd(g.costUSD)}</td>
      <td class="num c-carbon">${co2(g.carbon.gramsCO2e.mid)}</td></tr>`;
  }).join('');

  s.insertAdjacentHTML('beforeend', `<table><thead><tr>
      <th>Modèle</th><th>Tokens</th><th>Part</th><th>Requêtes</th><th>Coût</th><th>CO₂e</th>
    </tr></thead><tbody>${rows || '<tr><td colspan="6" class="faint">Aucune donnée</td></tr>'}</tbody></table>`);
  return s;
}

function breakdownCard() {
  const s = card('span-5', 'Nature des tokens', 'le cache change tout');
  const t = snap.report.totals.tokens;
  const parts = [
    { label: 'Lus en cache', value: t.cacheRead, color: 'var(--rule)' },
    { label: 'Écrits en cache', value: t.cacheWrite, color: 'var(--cost)' },
    { label: 'Entrée', value: t.input, color: 'var(--carbon)' },
    { label: 'Sortie', value: t.output, color: 'var(--tokens)' },
  ];
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;

  s.insertAdjacentHTML('beforeend', `<table><tbody>${parts.map((p) => `<tr>
      <td><div class="name-cell"><i class="swatch" style="background:${p.color}"></i><span>${p.label}</span></div></td>
      <td class="num">${tokens(p.value)}</td>
      <td class="num faint">${pct((p.value / total) * 100, 1)}</td></tr>`).join('')}</tbody></table>
    <div class="note" style="margin-top:11px">
      Taux de réutilisation du cache : <strong class="num">${pct(snap.report.totals.cacheHitRatio * 100, 1)}</strong>.
      Sans lui, la période aurait coûté <strong class="num">${usd(snap.report.totals.costWithoutCacheUSD)}</strong>
      au lieu de <strong class="num">${usd(snap.report.totals.costUSD)}</strong>.
    </div>`);
  return s;
}

function projectsCard() {
  const s = card('span-6', 'Par projet');
  const rows = snap.report.byProject.slice(0, 10).map((p) => `<tr>
      <td><div class="name-cell"><span>${esc(p.key)}</span></div></td>
      <td class="num">${tokens(p.tokens.total)}</td>
      <td class="num c-cost">${usd(p.costUSD)}</td>
      <td class="num c-carbon">${co2(p.carbon.gramsCO2e.mid)}</td></tr>`).join('');
  s.insertAdjacentHTML('beforeend', `<table><thead><tr><th>Projet</th><th>Tokens</th><th>Coût</th><th>CO₂e</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="faint">Aucune donnée</td></tr>'}</tbody></table>`);
  return s;
}

function carbonCard() {
  const s = card('span-6', 'Empreinte carbone', 'méthodologie EcoLogits');
  const c = snap.report.totals.carbon;
  const g = c.gramsCO2e;

  const host = document.createElement('div');
  s.appendChild(host);
  requestAnimationFrame(() => rangeBar(host, g.min, g.mid, g.max, g.max));

  s.insertAdjacentHTML('beforeend', `
    <div style="display:flex;justify-content:space-between;margin-top:5px;font-size:10.5px" class="faint num">
      <span>${co2(g.min)}</span><span>médiane ${co2(g.mid)}</span><span>${co2(g.max)}</span></div>
    <div class="equivs">${snap.report.totals.equivalents.slice(0, 4).map((e) => `
      <div class="equiv"><div style="font-size:14px">${e.icon}</div>
        <div class="n num">${nf(e.amount, e.amount < 10 ? 1 : 0)}</div>
        <div class="l faint">${esc(e.label)}</div></div>`).join('')}</div>
    <div class="note" style="margin-top:13px">
      Estimation par la méthode <strong>EcoLogits / Boavizta</strong> : énergie par token issue du nombre de
      paramètres actifs, plus le PUE du centre de données et l'amortissement de la fabrication du matériel.
      La fourchette est large parce que les fournisseurs ne publient pas la taille de leurs modèles —
      afficher un chiffre unique laisserait croire à une mesure.
      Mix électrique retenu : <code>${esc((snap.config.carbon || {}).gridKey || 'us-average')}</code>, modifiable dans les réglages.
    </div>`);
  return s;
}

function sourcesCard() {
  const s = card('span-6', 'Sources');
  const wrap = document.createElement('div');
  for (const src of snap.sources) {
    const color = src.error ? 'var(--hot)'
      : src.eventsInRange ? 'var(--carbon)'
      : src.available ? 'var(--tokens)' : 'var(--rule)';
    const detail = src.error || src.note
      || (src.eventsInRange ? `${nf(src.eventsInRange)} requêtes sur la période`
      : src.events ? 'aucune activité sur la période' : 'aucune donnée');
    const provider = { 'claude-code': 'anthropic', 'anthropic-oauth': 'anthropic', 'anthropic-api': 'anthropic',
      'codex-cli': 'openai', 'openai-api': 'openai', 'gemini-cli': 'google', ollama: 'local' }[src.id] || 'unknown';
    wrap.insertAdjacentHTML('beforeend', `<div class="src">
        ${providerMark(provider, 13)}
        <i class="dot" style="background:${color}"></i>
        <div class="info"><div>${esc(src.label)}</div><div class="sub">${esc(detail)}</div></div>
        <span class="count num faint" title="Total indexé">${src.events ? nf(src.events) : ''}</span></div>`);
  }
  s.appendChild(wrap);
  return s;
}

function hoursCard() {
  const s = card('span-6', 'Répartition horaire', 'heure locale');
  const max = Math.max(1, ...snap.report.hours.map((h) => h.tokens));
  const grid = document.createElement('div');
  grid.className = 'hours';
  grid.innerHTML = snap.report.hours.map((h) => {
    const pctH = Math.max(h.tokens > 0 ? 3 : 0, (h.tokens / max) * 100);
    return `<i style="height:${pctH}%" title="${h.hour} h — ${tokens(h.tokens)}"></i>`;
  }).join('');
  s.appendChild(grid);
  s.insertAdjacentHTML('beforeend',
    `<div class="hours-axis">${snap.report.hours.map((h) => (h.hour % 6 === 0 ? h.hour : '')).join('</span><span>').replace(/^/, '<span>').replace(/$/, '</span>')}</div>`);
  return s;
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function render() {
  if (!snap) return;
  $('#updated').textContent = snap.staleError ? 'données figées' : ago(snap.generatedAt);
  for (const b of document.querySelectorAll('#range-seg button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days));
  }

  renderHero();
  const main = $('#main');
  main.replaceChildren();

  if (!snap.report.eventCount) {
    main.innerHTML = `<div class="empty-state">
      <h2>Rien à afficher sur cette période</h2>
      <p class="note">TRACE lit les journaux locaux de Claude Code et Codex CLI.
      Élargissez la période, ou connectez une clé Admin dans les réglages pour récupérer
      la consommation facturée côté fournisseur.</p></div>`;
    return;
  }

  for (const c of [gaugesCard(), dailyCard(), modelsCard(), breakdownCard(), projectsCard(), carbonCard(), sourcesCard(), hoursCard()]) {
    main.appendChild(c);
  }
}

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

const GRIDS = [
  ['france', 'France — 56 g/kWh'], ['sweden', 'Suède / Nordique — 40'], ['canada', 'Canada — 120'],
  ['uk', 'Royaume-Uni — 210'], ['us-west', 'États-Unis Ouest — 240'], ['eu-27', 'Union européenne — 250'],
  ['us-east', 'États-Unis Est — 320'], ['us-average', 'États-Unis moyenne — 369'], ['germany', 'Allemagne — 380'],
  ['world', 'Moyenne mondiale — 480'], ['asia', 'Asie-Pacifique — 540'],
];

async function openSettings() {
  const cfg = await window.trace.getConfig();
  const body = $('#settings-body');
  body.innerHTML = `
    <div class="field">
      <label for="sc">Raccourci des jauges</label>
      <div class="help">Ouvre le panneau depuis n'importe quelle application.</div>
      <input type="text" id="sc" value="${esc(cfg.shortcut)}" />
    </div>
    <div class="field">
      <label for="grid">Mix électrique du calcul carbone</label>
      <div class="help">Intensité carbone du réseau qui alimente le centre de données.
        Les modèles fermés tournent le plus souvent aux États-Unis.</div>
      <select id="grid">${GRIDS.map(([k, l]) => `<option value="${k}" ${(cfg.carbon || {}).gridKey === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="field">
      <label for="tray">Affichage dans la barre d'état</label>
      <select id="tray">
        ${[['session', 'Remplissage de la fenêtre'], ['tokens', 'Tokens'], ['cost', 'Coût'], ['carbon', 'CO₂e']]
          .map(([k, l]) => `<option value="${k}" ${cfg.trayMetric === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="interval">Intervalle d'actualisation</label>
      <div class="row2"><input type="number" id="interval" min="15" max="3600" value="${cfg.refreshIntervalSec}" /><span class="faint">secondes</span></div>
    </div>
    <div class="field">
      <label class="switch"><input type="checkbox" id="login" ${cfg.launchAtLogin ? 'checked' : ''} /> Lancer au démarrage</label>
    </div>
    <div class="field">
      <label for="ak">Clé Admin Anthropic</label>
      <div class="help">Facultatif. Récupère la consommation facturée de toute l'organisation, au-delà de cette machine.
        ${cfg.encryptionAvailable
          ? 'Chiffrée par le trousseau du système.'
          : '<strong class="c-hot">Trousseau indisponible : TRACE refusera d\'enregistrer une clé en clair.</strong>'}</div>
      <div class="row2"><input type="password" id="ak" placeholder="${cfg.anthropicAdminKey ? '•••••••• (enregistrée)' : 'sk-ant-admin…'}" />
        <button class="btn" id="save-ak">Enregistrer</button></div>
      <div class="msg" id="ak-msg"></div>
    </div>
    <div class="field">
      <label for="ok">Clé Admin OpenAI</label>
      <div class="help">Facultatif, pour la consommation de l'organisation OpenAI.</div>
      <div class="row2"><input type="password" id="ok" placeholder="${cfg.openaiAdminKey ? '•••••••• (enregistrée)' : 'sk-admin-…'}" />
        <button class="btn" id="save-ok">Enregistrer</button></div>
      <div class="msg" id="ok-msg"></div>
    </div>
    <div class="field" style="display:flex;gap:8px">
      <button class="btn primary" id="save-settings">Appliquer</button>
      <span class="spacer" style="margin-left:auto"></span>
      <button class="btn" id="quit">Quitter TRACE</button>
    </div>`;

  const saveKey = async (provider, inputId, msgId) => {
    const input = document.getElementById(inputId);
    const msg = document.getElementById(msgId);
    const res = await window.trace.setKey(provider, input.value.trim() || null);
    msg.textContent = res.ok ? 'Clé enregistrée.' : res.error;
    msg.className = `msg ${res.ok ? 'c-carbon' : 'c-hot'}`;
    if (res.ok) input.value = '';
  };
  $('#save-ak').onclick = () => saveKey('anthropic', 'ak', 'ak-msg');
  $('#save-ok').onclick = () => saveKey('openai', 'ok', 'ok-msg');
  $('#quit').onclick = () => window.trace.quit();

  $('#save-settings').onclick = async () => {
    await window.trace.setConfig({
      shortcut: $('#sc').value.trim(),
      carbon: { ...(cfg.carbon || {}), gridKey: $('#grid').value },
      trayMetric: $('#tray').value,
      refreshIntervalSec: Number($('#interval').value) || 60,
      launchAtLogin: $('#login').checked,
    });
    $('#settings').close();
  };

  $('#settings').showModal();
}

// ---------------------------------------------------------------------------

$('#range-seg').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  days = Number(b.dataset.days);
  snap = await window.trace.getSnapshot({ days });
  render();
};
$('#refresh').onclick = async () => { snap = await window.trace.refresh(); render(); };
$('#export').onclick = () => window.trace.exportCsv({ days });
$('#settings-btn').onclick = openSettings;
$('#close-settings').onclick = () => $('#settings').close();

window.trace.onUpdate((payload) => { snap = payload; render(); });
window.addEventListener('resize', () => { if (snap) render(); });

(async () => {
  snap = await window.trace.getSnapshot({ days });
  render();
  setInterval(() => { if (snap && !snap.staleError) $('#updated').textContent = ago(snap.generatedAt); }, 5000);
})();
