import { tokens, usd, co2, pct, windowLabel, ago, esc } from '../shared/format.js';
import { gauge } from '../shared/charts.js';
import { providerMark } from '../shared/marks.js';

const $ = (id) => document.getElementById(id);

let snap = null;

function renderGauge(g) {
  const wrap = document.createElement('div');
  wrap.className = 'gauge-row';

  const head = document.createElement('div');
  head.className = 'gauge-head';
  const shown = g.percent == null
    ? `<span class="faint num" style="font-size:11px">${tokens(g.used)} consommés</span>`
    : `${g.approximate ? '≈ ' : ''}${pct(g.percent)}`;
  head.innerHTML = `${providerMark(g.provider, 12)}<span class="legend">${esc(g.label)}</span>
    <span class="val num ${g.percent >= 85 ? 'c-hot' : ''}${g.approximate ? ' faint' : ''}">${shown}</span>`;
  wrap.appendChild(head);

  const bar = document.createElement('div');
  wrap.appendChild(bar);

  const sub = document.createElement('div');
  sub.className = 'gauge-sub faint';

  // On dit toujours D'OÙ vient l'échelle. Une jauge dont le plafond a été
  // deviné ne doit pas se faire passer pour une mesure du fournisseur.
  const origin = {
    live: 'en direct',
    'live-stale': `relevé ${g.reportedAt ? ago(g.reportedAt) : 'ancien'}`,
    derived: 'déduit du dernier relevé',
    reset: 'fenêtre réinitialisée',
    provider: 'donné par le fournisseur',
    user: 'calé sur votre relevé',
    observed: 'estimé — ajustez dans le tableau de bord',
    configured: 'plafond que vous avez renseigné',
  }[g.limitSource] || 'échelle inconnue — à caler';

  sub.innerHTML = `<span${g.stale ? ' class="c-hot"' : ''}>${esc(windowLabel(g))}</span>
    <span class="right">${esc(origin)}</span>`;
  wrap.appendChild(sub);

  requestAnimationFrame(() => gauge(bar, g.percent, { height: 9, approximate: g.approximate }));
  return wrap;
}

function render() {
  const body = $('body');
  if (!snap) return;

  const t = snap.report.totals;
  $('range-label').textContent = `${snap.range.days} jours`;
  $('status').textContent = snap.staleError ? 'données figées' : ago(snap.generatedAt);
  $('status').className = `status legend ${snap.staleError ? 'c-hot' : ''}`;

  if (!snap.report.eventCount) {
    body.innerHTML = `<div class="empty">
      <h2>Aucune consommation détectée</h2>
      <p>TRACE lit les journaux locaux de Claude Code, Codex et Gemini CLI.
      Lancez un de ces outils, puis actualisez.</p></div>`;
    return;
  }

  body.replaceChildren();

  // Toutes les jauges tiennent désormais : c'est ce que le popover doit
  // montrer. Le relevé en direct passe devant, puis les fenêtres les plus
  // remplies — on veut voir en premier ce qui est près de saturer.
  const ranked = [...snap.gauges].sort((a, b) => {
    const rank = (g) => (g.limitSource === 'live' ? 0 : g.percent == null ? 2 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (b.percent || 0) - (a.percent || 0);
  });
  for (const g of ranked) body.appendChild(renderGauge(g));

  const triad = document.createElement('div');
  triad.className = 'triad';
  const c = t.carbon.gramsCO2e;
  triad.innerHTML = `
    <div><div class="legend">Tokens</div><div class="v num c-tokens">${tokens(t.tokens.total)}</div>
         <div class="x faint num">${tokens(t.requests)} requêtes</div></div>
    <div><div class="legend">Coût</div><div class="v num c-cost">${usd(t.costUSD)}</div>
         <div class="x faint num">${usd(t.cacheSavingsUSD)} évités</div></div>
    <div><div class="legend">CO₂e</div><div class="v num c-carbon">${co2(c.mid)}</div>
         <div class="x faint num">${co2(c.min)} – ${co2(c.max)}</div></div>`;
  body.appendChild(triad);
}

$('open-dash').onclick = () => window.trace.openDashboard();
$('quit').onclick = () => window.trace.quit();
$('refresh').onclick = async () => {
  $('status').textContent = 'lecture…';
  snap = await window.trace.refresh();
  render();
};

// Échap referme, comme n'importe quel popover du système.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.trace.closePopover();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) window.trace.openDashboard();
});

window.trace.onUpdate((payload) => {
  snap = payload;
  render();
});

(async () => {
  snap = await window.trace.getSnapshot();
  const cfg = await window.trace.getConfig();
  $('shortcut-hint').textContent = (cfg.shortcut || '').replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replace(/\+/g, ' ');
  render();
  // L'horodatage « il y a N s » doit vieillir tout seul tant que le popover est ouvert.
  setInterval(() => { if (snap && !snap.staleError) $('status').textContent = ago(snap.generatedAt); }, 5000);
})();
