import { tokens, usd, co2, pct, windowLabel, ago, esc } from '../shared/format.js';
import { gauge } from '../shared/charts.js';
import { providerMark } from '../shared/marks.js';
import { groupByProduct, originLabel, timingLabel, projectionLabel } from '../shared/gauges.js';
import { initI18n, applyStaticI18n, t, lang } from '../shared/i18n.js';

const $ = (id) => document.getElementById(id);

let snap = null;

/** Une fenêtre, à l'intérieur d'un bloc produit. */
function renderWindow(g) {
  const row = document.createElement('div');
  row.className = 'win';

  const shown = g.percent == null
    ? `<span class="faint num" style="font-size:11px">${tokens(g.used)} consommés</span>`
    : `${g.approximate ? '≈ ' : ''}${pct(g.percent)}`;

  row.innerHTML = `<div class="win-top">
      <span class="wname">${esc(g.label)}</span>
      <span class="val num ${g.percent >= 85 ? 'c-hot' : ''}${g.approximate ? ' faint' : ''}">${shown}</span>
    </div><div class="bar"></div>
    <div class="win-meta faint"><span>${esc(timingLabel(g))}</span>${
      projectionLabel(g) ? `<span class="proj c-hot">${esc(projectionLabel(g))}</span>` : ''
    }</div>`;

  requestAnimationFrame(() => gauge(row.querySelector('.bar'), g.percent, { height: 8, approximate: g.approximate }));
  return row;
}

/** Un produit : sa marque et son nom une seule fois, puis ses fenêtres. */
function renderBlock(block) {
  const wrap = document.createElement('div');
  wrap.className = 'block';
  wrap.innerHTML = `<div class="block-head">
      ${providerMark(block.provider, 13)}
      <span class="pname">${esc(block.product)}</span>
      ${block.origin ? `<span class="origin faint">${esc(block.origin)}</span>` : ''}
    </div>`;
  for (const g of block.gauges) {
    const row = renderWindow(g);
    // Provenance hétérogène dans le bloc : on la remet sur chaque ligne.
    if (!block.origin) row.querySelector('.win-meta').innerHTML +=
      `<span class="right">${esc(originLabel(g))}</span>`;
    wrap.appendChild(row);
  }
  return wrap;
}

function render() {
  const body = $('body');
  if (!snap) return;

  const tot = snap.report.totals;
  $('range-label').textContent = t('ui.days', { n: snap.range.days });
  $('status').textContent = snap.staleError ? t('ui.stale') : ago(snap.generatedAt);
  $('status').className = `status legend ${snap.staleError ? 'c-hot' : ''}`;

  if (!snap.report.eventCount) {
    body.innerHTML = `<div class="empty">
      <h2>${esc(t('popover.emptyTitle'))}</h2>
      <p>${esc(t('popover.emptyBody'))}</p></div>`;
    return;
  }

  body.replaceChildren();

  for (const block of groupByProduct(snap.gauges)) body.appendChild(renderBlock(block));

  // Un relevé qui ne bouge pas doit s'expliquer. Sans ça, l'utilisateur voit
  // un chiffre figé et conclut — à raison — que quelque chose est cassé.
  const ls = snap.liveStatus;
  if (ls && !ls.ok) {
    const warn = document.createElement('div');
    warn.className = 'live-warn';
    const wait = ls.nextAttemptIn > 0 ? ` ${t('live.retryIn', { n: Math.ceil(ls.nextAttemptIn / 60000) })}` : '';
    const titre = ls.waiting ? t('live.waiting') : t('live.unavailable');
    warn.innerHTML = `<span class="c-hot">${esc(titre)}</span> <span class="faint">${esc(ls.error)}.${esc(wait)}</span>`;
    body.appendChild(warn);
  }

  const triad = document.createElement('div');
  triad.className = 'triad';
  const c = tot.carbon.gramsCO2e;
  triad.innerHTML = `
    <div><div class="legend">${esc(t('metric.tokens'))}</div><div class="v num c-tokens">${tokens(tot.tokens.total)}</div>
         <div class="x faint num">${esc(t('triad.requests', { n: tokens(tot.requests) }))}</div></div>
    <div><div class="legend">${esc(t('metric.cost'))}</div><div class="v num c-cost">${usd(tot.costUSD)}</div>
         <div class="x faint num">${esc(t('triad.saved', { amount: usd(tot.cacheSavingsUSD) }))}</div></div>
    <div><div class="legend">CO₂e</div><div class="v num c-carbon">${co2(c.mid)}</div>
         <div class="x faint num">${co2(c.min)} – ${co2(c.max)}</div></div>`;
  body.appendChild(triad);
}

$('open-dash').onclick = () => window.trace.openDashboard();
$('quit').onclick = () => window.trace.quit();
$('refresh').onclick = async () => {
  $('status').textContent = t('ui.reading');
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
  // Le catalogue AVANT le premier rendu : peindre puis corriger ferait
  // clignoter l'écran sur des clés brutes.
  initI18n(await window.trace.getStrings());
  applyStaticI18n();
  document.documentElement.lang = lang();
  snap = await window.trace.getSnapshot();
  const cfg = await window.trace.getConfig();
  $('shortcut-hint').textContent = (cfg.shortcut || '').replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replace(/\+/g, ' ');
  render();
  // L'horodatage « il y a N s » doit vieillir tout seul tant que le popover est ouvert.
  setInterval(() => { if (snap && !snap.staleError) $('status').textContent = ago(snap.generatedAt); }, 5000);
})();
