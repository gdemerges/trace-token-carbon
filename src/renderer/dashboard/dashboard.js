import { nf, tokens, usd, co2, energy, water, pct, windowLabel, ago, shortDate, esc } from '../shared/format.js';
import { traceStrip, gauge, bars, rangeBar } from '../shared/charts.js';
import { providerMark, PROVIDER_LABEL } from '../shared/marks.js';
import { groupByProduct, originLabel, timingLabel, projectionLabel } from '../shared/gauges.js';
import { initI18n, applyStaticI18n, t, intl, lang } from '../shared/i18n.js';

const $ = (s) => document.querySelector(s);

let snap = null;
let days = 30;
let metric = 'tokens'; // grandeur affichée
let grain = 'day'; // granularité : 'day' (série) ou 'hour' (profil)

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
  const tot = snap.report.totals;
  const tr = snap.report.trend;
  const c = tot.carbon.gramsCO2e;

  $('#figures').innerHTML = `
    <div class="fig"><div class="legend">${esc(t('hero.tokens'))}</div>
      <div class="v num c-tokens">${tokens(tot.tokens.total)}</div>
      <div class="x faint num">${esc(t('hero.requests', { n: nf(tot.requests) }))}${tr.significant ? ` · ${trendChip(tr.tokens, tr.significant)}` : ''}</div></div>
    <div class="fig"><div class="legend">${esc(t('hero.cost'))}</div>
      <div class="v num c-cost">${usd(tot.costUSD)}</div>
      <div class="x faint num">${esc(t('hero.cacheSaved', { amount: usd(tot.cacheSavingsUSD) }))}${tr.significant ? ` · ${trendChip(tr.cost, tr.significant)}` : ''}</div></div>
    <div class="fig"><div class="legend">${esc(t('hero.carbon'))}</div>
      <div class="v num c-carbon">${co2(c.mid)}</div>
      <div class="x faint num">${co2(c.min)} – ${co2(c.max)}${tr.significant ? ` · ${trendChip(tr.carbon, tr.significant)}` : ''}</div></div>
    <div class="fig"><div class="legend">${esc(t('hero.energy'))}</div>
      <div class="v num">${energy(tot.carbon.energyWh.mid)}</div>
      <div class="x faint num">${energy(tot.carbon.energyWh.min)} – ${energy(tot.carbon.energyWh.max)}</div></div>`;

  requestAnimationFrame(() =>
    traceStrip($('#hero-strip'), snap.report.daily, { label: t('hero.stripLabel') })
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
  const s = card('span-5', t('gauges.title'));
  const wrap = document.createElement('div');
  wrap.className = 'gauges';

  if (!snap.gauges.length) {
    wrap.innerHTML = `<div class="note">${esc(t('gauges.none'))}</div>`;
  }

  for (const block of groupByProduct(snap.gauges)) {
    const b = document.createElement('div');
    b.className = 'block';
    b.innerHTML = `<div class="block-head">
        ${providerMark(block.provider, 14)}
        <span class="pname">${esc(block.product)}</span>
        ${block.origin ? `<span class="origin faint">${esc(block.origin)}</span>` : ''}
      </div>`;

    for (const g of block.gauges) {
      const row = document.createElement('div');
      row.className = 'win';

      // Sans échelle fiable, on n'invente pas de pourcentage : on montre ce
      // qu'on sait vraiment, la consommation pondérée de la fenêtre.
      const shown = g.percent == null
        ? `<span class="faint num" style="font-size:12px">${esc(t('gauges.used', { amount: tokens(g.used) }))}</span>`
        : `${g.approximate ? '≈ ' : ''}${pct(g.percent)}`;

      row.innerHTML = `<div class="win-top">
          <span class="wname">${esc(g.label)}</span>
          ${g.calibratable ? `<button class="calib" type="button">${esc(t('gauges.adjust'))}</button>` : ''}
          <span class="val num ${g.percent >= 85 ? 'c-hot' : ''}${g.approximate ? ' faint' : ''}">${shown}</span>
        </div><div class="bar"></div>
        <div class="win-meta faint"><span>${esc(timingLabel(g))}</span>${
          projectionLabel(g) ? `<span class="proj c-hot">${esc(t('gauge.atThisPace', { label: projectionLabel(g) }))}</span>` : ''
        }${
          block.origin ? '' : `<span class="right">${esc(originLabel(g))}</span>`
        }</div>`;

      b.appendChild(row);
      requestAnimationFrame(() => gauge(row.querySelector('.bar'), g.percent, { height: 9, approximate: g.approximate }));

      const calibBtn = row.querySelector('.calib');
      if (calibBtn) calibBtn.onclick = () => openCalibration(row, g);
    }
    wrap.appendChild(b);
  }
  s.appendChild(wrap);

  const ls = snap.liveStatus;
  if (ls && !ls.ok) {
    const wait = ls.nextAttemptIn > 0 ? ` ${t('live.retryIn', { n: Math.ceil(ls.nextAttemptIn / 60000) })}` : '';
    const titre = ls.waiting ? t('live.waiting') : t('live.unavailable');
    s.insertAdjacentHTML('beforeend',
      `<div class="note" style="margin-top:12px;padding:9px 10px;background:var(--hot-soft);border-radius:5px">
        <strong class="c-hot">${esc(titre)}</strong> ${esc(ls.error)}.${esc(wait)}
        ${esc(t('live.lastGood'))}
      </div>`);
  }
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
  form.innerHTML = `<span class="faint">${t('calib.prompt', { cmd: '<code>/usage</code>' })}</span>
    <span class="calib-input"><input type="number" min="1" max="100" step="1" required placeholder="72" aria-label="${esc(t('calib.aria'))}" /> %</span>
    <button class="btn primary" type="submit">${esc(t('calib.submit'))}</button>
    <button class="btn" type="button" data-cancel>${esc(t('calib.cancel'))}</button>
    <span class="calib-msg"></span>`;
  row.appendChild(form);
  form.querySelector('input').focus();

  const close = () => { form.remove(); releaseRender(); };

  form.querySelector('[data-cancel]').onclick = close;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const value = Number(form.querySelector('input').value);
    const msg = form.querySelector('.calib-msg');
    const res = await window.trace.calibrate(g.id, value);
    if (res.ok) close();
    else { msg.textContent = res.error; msg.className = 'calib-msg c-hot'; }
  };
}

/**
 * Consommation dans le temps — série journalière et profil horaire réunis.
 *
 * Les deux répondaient à deux questions voisines dans deux cartes séparées :
 * « combien ai-je consommé au fil des jours » et « à quelles heures ». Un seul
 * panneau avec une bascule de granularité les rapproche, et permet surtout
 * d'appliquer la MÊME grandeur aux deux — le profil horaire ne montrait que
 * les tokens, alors que savoir à quelle heure part l'argent ou le carbone est
 * tout aussi parlant.
 */
function consumptionCard() {
  const s = card('span-7 chart', t('consumption.title'));

  const seg = (options, current, onPick) => {
    const el = document.createElement('div');
    el.className = 'seg';
    for (const [k, label] of options) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(current === k));
      b.onclick = () => { onPick(k); render(); };
      el.appendChild(b);
    }
    return el;
  };

  const head = s.querySelector('h2');
  const controls = document.createElement('div');
  controls.className = 'card-controls';
  controls.appendChild(seg([['day', t('consumption.byDay')], ['hour', t('consumption.byHour')]], grain, (k) => { grain = k; }));
  controls.appendChild(seg([['tokens', t('metric.tokens')], ['cost', t('metric.cost')], ['carbon', t('metric.carbon')]], metric, (k) => { metric = k; }));
  head.appendChild(controls);

  // Le graphe occupe la hauteur restante : les cartes d'une même ligne
  // s'alignent, et celle-ci ne laisse plus un vide sous ses barres.
  const host = document.createElement('div');
  host.className = 'chart-host';
  s.appendChild(host);

  const axis = document.createElement('div');
  axis.className = 'faint num chart-axis';
  s.appendChild(axis);

  const pick = { tokens: (x) => x.tokens.total ?? x.tokens, cost: (x) => x.costUSD, carbon: (x) => x.gramsCO2e }[metric];
  const fmt = { tokens, cost: usd, carbon: co2 }[metric];
  const color = { tokens: 'var(--tokens)', cost: 'var(--cost)', carbon: 'var(--carbon)' }[metric];

  if (grain === 'day') {
    const d = snap.report.daily;
    axis.innerHTML = d.length
      ? `<span>${shortDate(d[0].date)}</span><span>${shortDate(d[Math.floor(d.length / 2)].date)}</span><span>${shortDate(d[d.length - 1].date)}</span>`
      : '';
    requestAnimationFrame(() =>
      bars(host, d.map((x) => ({ value: pick(x), color, title: `${x.date} — ${fmt(pick(x))}` })))
    );
  } else {
    const h = snap.report.hours;
    // Les heures creuses restent visibles : un profil de travail se lit autant
    // par ses trous que par ses pics.
    axis.innerHTML = [0, 6, 12, 18, 23].map((n) => `<span>${esc(t('consumption.hourAxis', { n: String(n).padStart(2, '0') }))}</span>`).join('');
    requestAnimationFrame(() =>
      bars(host, h.map((x) => ({
        value: pick(x),
        color,
        highlight: x.hour === new Date().getHours(),
        title: t('consumption.hourTip', { hour: String(x.hour).padStart(2, '0'), value: fmt(pick(x)), n: nf(x.requests) }),
      })))
    );
  }
  return s;
}

function modelsCard() {
  const s = card('span-7', t('models.title'));
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
      <th>${esc(t('models.col'))}</th><th>${esc(t('col.tokens'))}</th><th>${esc(t('col.share'))}</th>
      <th>${esc(t('col.requests'))}</th><th>${esc(t('col.cost'))}</th><th>CO₂e</th>
    </tr></thead><tbody>${rows || `<tr><td colspan="6" class="faint">${esc(t('table.empty'))}</td></tr>`}</tbody></table>`);
  return s;
}

function breakdownCard() {
  const s = card('span-5', t('breakdown.title'), esc(t('breakdown.aside')));
  const tok = snap.report.totals.tokens;
  const parts = [
    { label: t('breakdown.cacheRead'), value: tok.cacheRead, color: 'var(--rule)' },
    { label: t('breakdown.cacheWrite'), value: tok.cacheWrite, color: 'var(--cost)' },
    { label: t('breakdown.input'), value: tok.input, color: 'var(--carbon)' },
    { label: t('breakdown.output'), value: tok.output, color: 'var(--tokens)' },
  ];
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;

  s.insertAdjacentHTML('beforeend', `<table><tbody>${parts.map((p) => `<tr>
      <td><div class="name-cell"><i class="swatch" style="background:${p.color}"></i><span>${esc(p.label)}</span></div></td>
      <td class="num">${tokens(p.value)}</td>
      <td class="num faint">${pct((p.value / total) * 100, 1)}</td></tr>`).join('')}</tbody></table>
    <div class="note" style="margin-top:11px">${t('breakdown.note', {
      ratio: `<strong class="num">${pct(snap.report.totals.cacheHitRatio * 100, 1)}</strong>`,
      without: `<strong class="num">${usd(snap.report.totals.costWithoutCacheUSD)}</strong>`,
      withCache: `<strong class="num">${usd(snap.report.totals.costUSD)}</strong>`,
    })}</div>`);
  return s;
}

function projectsCard() {
  const s = card('span-7', t('projects.title'));
  const rows = snap.report.byProject.slice(0, 10).map((p) => `<tr>
      <td><div class="name-cell"><span>${esc(p.key)}</span></div></td>
      <td class="num">${tokens(p.tokens.total)}</td>
      <td class="num c-cost">${usd(p.costUSD)}</td>
      <td class="num c-carbon">${co2(p.carbon.gramsCO2e.mid)}</td></tr>`).join('');
  s.insertAdjacentHTML('beforeend', `<table><thead><tr><th>${esc(t('col.project'))}</th><th>${esc(t('col.tokens'))}</th>
    <th>${esc(t('col.cost'))}</th><th>CO₂e</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="faint">${esc(t('table.empty'))}</td></tr>`}</tbody></table>`);
  return s;
}

function carbonCard() {
  const s = card('span-12', t('carbon.title'), esc(t('carbon.aside')));
  const c = snap.report.totals.carbon;
  const g = c.gramsCO2e;

  const host = document.createElement('div');
  s.appendChild(host);
  requestAnimationFrame(() => rangeBar(host, g.min, g.mid, g.max, g.max));

  s.insertAdjacentHTML('beforeend', `
    <div style="display:flex;justify-content:space-between;margin-top:5px;font-size:10.5px" class="faint num">
      <span>${co2(g.min)}</span><span>${esc(t('carbon.median', { amount: co2(g.mid) }))}</span><span>${co2(g.max)}</span></div>
    <div class="equivs">${snap.report.totals.equivalents.slice(0, 4).map((e) => `
      <div class="equiv"><div style="font-size:14px">${e.icon}</div>
        <div class="n num">${nf(e.amount, e.amount < 10 ? 1 : 0)}</div>
        <div class="l faint">${esc(e.label)}</div></div>`).join('')}</div>`);

  // L'eau ne se déduit pas du carbone : elle dépend du refroidissement du site
  // ET du mix électrique. Un bilan qui n'en parle pas laisse croire que le
  // carbone est le seul impact du calcul, ce qui est faux.
  if (c.waterL && c.waterL.mid > 0) {
    s.insertAdjacentHTML('beforeend', `
      <div class="sens-head">${esc(t('carbon.water'))}</div>
      <div class="water-line">
        <span class="num" style="font-size:14px;font-weight:600">${water(c.waterL.mid)}</span>
        <span class="faint num">${water(c.waterL.min)} – ${water(c.waterL.max)}</span>
        <span class="faint">${esc(t('carbon.waterNote'))}</span>
      </div>`);
  }

  s.appendChild(sensitivityBlock());
  s.appendChild(uncertaintyBlock());

  s.insertAdjacentHTML('beforeend', `
    <div class="note" style="margin-top:13px;max-width:78ch">
      ${t('carbon.method')}
      <code>${esc((snap.config.carbon || {}).gridKey || 'us-average')}</code>${esc(t('carbon.gridEditable'))}
    </div>`);
  return s;
}

/**
 * Le même total sous quatre mix électriques.
 *
 * C'est l'hypothèse la plus contestable du calcul : personne ne sait où tourne
 * l'inférence. La montrer à côté du total vaut mieux que de la cacher derrière
 * lui — un lecteur voit d'un coup ce que le chiffre doit à une supposition de
 * géographie, et non à une mesure.
 */
function sensitivityBlock() {
  const rows = snap.report.totals.carbonSensitivity || [];
  const wrap = document.createElement('div');
  if (!rows.length) return wrap;

  const scale = Math.max(...rows.map((r) => r.gramsCO2e.mid)) || 1;
  const current = (snap.config.carbon || {}).gridKey || 'us-average';

  wrap.innerHTML = `<div class="sens-head">${esc(t('carbon.elsewhere'))}</div>
    ${rows.map((r) => `
      <div class="sens${r.key === current ? ' on' : ''}">
        <span class="l">${esc(r.label)}</span>
        <span class="faint num i">${nf(r.intensity)} g/kWh</span>
        <span class="track"><i style="width:${Math.max(1, (r.gramsCO2e.mid / scale) * 100)}%"></i></span>
        <span class="num v">${co2(r.gramsCO2e.mid)}</span>
        <span class="faint num r">${r.ratio == null ? '' : `× ${nf(r.ratio, 2)}`}</span>
      </div>`).join('')}`;
  return wrap;
}

/**
 * D'où vient la fourchette, levier par levier.
 *
 * Une fourchette d'un ordre de grandeur se lit comme un aveu d'imprécision
 * générale. En pratique un seul terme domine, et c'est celui-là qu'il faut
 * aller corriger ou défendre. Chaque barre montre le rapport haut/bas que le
 * levier produit à lui seul, tous les autres figés.
 */
function uncertaintyBlock() {
  const levers = snap.report.totals.carbonUncertainty || [];
  const wrap = document.createElement('div');
  if (!levers.length) return wrap;

  const scale = Math.max(...levers.map((l) => l.ratio)) || 1;
  wrap.innerHTML = `<div class="sens-head">${esc(t('carbon.uncertainty'))}</div>
    ${levers.map((l) => `
      <div class="lever" title="${esc(l.note)}">
        <span class="l">${esc(l.label)}</span>
        <span class="track"><i style="width:${Math.max(1, (l.ratio / scale) * 100)}%"></i></span>
        <span class="num v">× ${nf(l.ratio, 1)}</span>
      </div>`).join('')}
    <div class="note" style="margin-top:8px;max-width:78ch">${esc(t('carbon.uncertaintyNote'))}</div>`;
  return wrap;
}

/**
 * L'annexe méthodologique, à l'écran.
 *
 * Le registre des facteurs et celui des sources existaient déjà, et ne
 * sortaient nulle part : un total que l'utilisateur devait croire sur parole.
 * Le tableau est replié par défaut — il ne doit pas encombrer la lecture
 * courante, mais il doit être à un clic, pas à une lecture de code source.
 */
function methodologyCard() {
  const s = card('span-12', t('method.title'), esc(t('method.count', { n: snap.methodology.factors.length })));
  const unpinned = snap.methodology.unpinned || [];

  // Le bandeau n'est pas une alerte d'erreur : l'ordre de grandeur est bon.
  // Il dit ce qui manque pour qu'un chiffre passe d'« informatif » à
  // « opposable », et c'est une distinction qu'un livrable doit porter.
  if (unpinned.length) {
    s.insertAdjacentHTML('beforeend', `
      <div class="warn-band">
        <strong>${esc(t('method.unpinned', { n: unpinned.length }))}</strong>
        ${esc(t('method.unpinnedBody', {
          publishers: [...new Set(unpinned.map((u) => u.publisher.split(/[,(]/)[0].trim()))].join(' · '),
        }))}
      </div>`);
  }

  const groups = new Map();
  for (const f of snap.methodology.factors) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }

  const det = document.createElement('details');
  det.className = 'annex';
  // Identifiant stable : `render()` reconstruit la carte, et sans lui l'annexe
  // se refermait toute seule sous les yeux de qui la lisait.
  det.id = 'method-annex';
  det.open = annexOpen;
  det.addEventListener('toggle', () => { annexOpen = det.open; });
  det.innerHTML = `<summary>${esc(t('method.summary'))}</summary>
    ${[...groups].map(([group, rows]) => `
      <div class="annex-group">${esc(group)}</div>
      <table><thead><tr><th>${esc(t('method.colFactor'))}</th><th>${esc(t('method.colValue'))}</th>
      <th>${esc(t('method.colUnit'))}</th><th>${esc(t('method.colSource'))}</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td>${esc(r.key)}${r.note ? `<div class="faint annex-note">${esc(r.note)}</div>` : ''}</td>
          <td class="num">${esc(r.value)}</td>
          <td class="faint">${esc(r.unit)}</td>
          <td class="faint annex-cite">${esc(r.citation)}</td>
        </tr>`).join('')}</tbody></table>`).join('')}
    <div class="note" style="margin-top:12px;max-width:78ch">${t('method.annexNote')}${esc(t('method.frenchNotes'))}</div>`;
  s.appendChild(det);
  return s;
}

function sourcesCard() {
  const s = card('span-5', t('sources.title'));
  const wrap = document.createElement('div');
  for (const src of snap.sources) {
    const color = src.error ? 'var(--hot)'
      : src.eventsInRange || src.quota ? 'var(--carbon)'
      : src.available ? 'var(--tokens)' : 'var(--rule)';
    const detail = src.error
      || (src.quota ? t('sources.windows', { n: src.quota })
      : src.eventsInRange ? t('sources.requests', { n: nf(src.eventsInRange) })
      : src.note
      || (src.events ? t('sources.idle') : t('sources.nothing')));
    const provider = { 'claude-code': 'anthropic', 'anthropic-oauth': 'anthropic', 'anthropic-api': 'anthropic',
      'codex-cli': 'openai', 'openai-api': 'openai' }[src.id] || 'unknown';
    wrap.insertAdjacentHTML('beforeend', `<div class="src">
        ${providerMark(provider, 13)}
        <i class="dot" style="background:${color}"></i>
        <div class="info"><div>${esc(src.label)}</div><div class="sub">${esc(detail)}</div></div>
        <span class="count num faint" title="${esc(t('sources.indexed'))}">${src.events ? nf(src.events) : ''}</span></div>`);
  }
  s.appendChild(wrap);
  return s;
}

// ---------------------------------------------------------------------------
// Rendu
/**
 * Confrontation mesure locale / chiffre facturé.
 *
 * C'est la seule vérification EXTERNE dont TRACE dispose sur ses propres
 * chiffres. Tout le reste — tarifs, pondérations, facteurs carbone — se
 * vérifie par la méthode ; la volumétrie, elle, ne se vérifie que contre la
 * facture. Un écart durable dit soit qu'une autre machine consomme sur le même
 * compte, soit que la lecture des journaux se trompe. Les deux méritent d'être
 * vues plutôt que moyennées en silence.
 *
 * La carte n'apparaît que s'il y a matière à comparer : une clé Admin
 * renseignée ET des jours où les deux sources ont parlé.
 */
function reconciliationCard() {
  const rows = snap.report.reconciliation || [];
  if (!rows.length) return null;

  const s = card('span-5', t('recon.title'), esc(t('recon.aside')));
  for (const r of rows) {
    const dir = r.deltaPct >= 0 ? t('recon.more') : t('recon.less');
    const ecart = Math.abs(r.deltaPct);
    // Sous 5 %, l'écart relève de l'arrondi des fenêtres journalières : on le
    // chiffre sans le colorer, pour ne pas transformer un accord en alarme.
    const cls = ecart < 5 ? 'faint' : 'c-hot';
    s.insertAdjacentHTML('beforeend', `<div class="recon">
        <div class="recon-head">
          <span class="pname">${esc(PROVIDER_LABEL[r.family] || r.family)}</span>
          <span class="num ${cls}">${esc(ecart < 0.5 ? t('recon.negligible') : t('recon.delta', { pct: pct(ecart, 1), dir }))}</span>
        </div>
        <div class="recon-pair">
          <span>${t('recon.local', { amount: `<strong class="num">${tokens(r.local)}</strong>` })}</span>
          <span>${t('recon.billed', { amount: `<strong class="num">${tokens(r.billed)}</strong>` })}</span>
          <span class="faint">${esc(t('recon.days', { n: r.days.length }))}</span>
        </div>
      </div>`);
  }
  s.insertAdjacentHTML('beforeend', `<div class="note" style="margin-top:10px">${esc(t('recon.note'))}</div>`);
  return s;
}

// ---------------------------------------------------------------------------

/**
 * Ce qui doit survivre à un rendu.
 *
 * `render()` vide `#main` et reconstruit les neuf cartes. Tout ce que
 * l'utilisateur avait ouvert ou saisi disparaissait donc avec elles, à chaque
 * cycle de rafraîchissement : l'annexe méthodologique se refermait, et le
 * formulaire de calibrage — un champ où l'on recopie précisément le
 * pourcentage lu dans `/usage` — était effacé en cours de frappe.
 *
 * Deux réponses, parce que deux natures d'état. Ce qui se résume à un booléen
 * se mémorise et se repose (l'annexe). Ce qui ne se résume pas — une saisie en
 * cours, un focus — ne se restaure pas : on diffère le rendu jusqu'à ce que
 * l'interaction soit finie.
 */
let annexOpen = false;
let renderPending = false;

/**
 * Vrai tant que l'utilisateur a la main dans une carte.
 *
 * On ne regarde que les champs de saisie, pas le focus en général : un bouton
 * de bascule garde le focus après le clic, et s'en tenir à `activeElement`
 * suspendait alors les rafraîchissements pour de bon.
 */
function interacting() {
  const main = $('#main');
  if (!main) return false;
  if (main.querySelector('.calib-form')) return true;
  const a = document.activeElement;
  return !!a && main.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
}

/**
 * Rendu demandé par un rafraîchissement de fond, donc annulable. Les rendus
 * provoqués par un clic de l'utilisateur appellent `render()` directement :
 * ils répondent à son geste, il n'y a rien à préserver.
 */
function requestRender() {
  if (interacting()) {
    renderPending = true;
    return;
  }
  renderPending = false;
  render();
}

/** Rattrape le rendu mis en attente, une fois l'interaction terminée. */
function releaseRender() {
  if (renderPending) requestRender();
}

function render() {
  if (!snap) return;
  $('#updated').textContent = snap.staleError ? t('ui.stale') : ago(snap.generatedAt);
  for (const b of document.querySelectorAll('#range-seg button')) {
    const v = b.dataset.days === 'all' ? 'all' : Number(b.dataset.days);
    b.setAttribute('aria-pressed', String(v === days));
  }

  // L'horizon est écrit noir sur blanc : une période longue qui semble vide
  // doit s'expliquer par la source, pas laisser croire à une perte de données.
  const h = snap.dataHorizon;
  $('#horizon').textContent = h && h.from
    ? t('ui.dataSince', { date: new Date(h.from).toLocaleDateString(intl()) })
    : '';

  renderHero();
  const main = $('#main');
  main.replaceChildren();

  if (!snap.report.eventCount) {
    main.innerHTML = `<div class="empty-state">
      <h2>${esc(t('empty.title'))}</h2>
      <p class="note">${esc(t('empty.body'))}</p></div>`;
    return;
  }

  const cards = [gaugesCard(), consumptionCard(), modelsCard(), breakdownCard(), projectsCard(),
                 reconciliationCard(), sourcesCard(), carbonCard(), methodologyCard()];
  for (const c of cards) if (c) main.appendChild(c);
}

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

/**
 * Liste des mix, dérivée du registre plutôt que recopiée : la version en dur
 * était déjà désynchronisable en silence — ajouter une zone dans `factors.js`
 * ne la faisait pas apparaître ici, et changer une intensité laissait un
 * libellé faux dans le menu.
 */
const gridOptions = () =>
  Object.entries(snap.methodology.grids)
    .sort((a, b) => a[1].value - b[1].value)
    .map(([k, g]) => [k, `${g.label} — ${g.value} g/kWh`]);

async function openSettings() {
  const cfg = await window.trace.getConfig();
  const body = $('#settings-body');
  body.innerHTML = `
    <div class="field">
      <label for="lang">${esc(t('set.language'))}</label>
      <div class="help">${esc(t('set.languageHelp'))}</div>
      <select id="lang">${[['auto', t('set.language.auto')], ['fr', t('set.language.fr')], ['en', t('set.language.en')]]
        .map(([k, l]) => `<option value="${k}" ${(cfg.locale || 'auto') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
    </div>
    <div class="field">
      <label for="sc">${esc(t('set.shortcut'))}</label>
      <div class="help">${esc(t('set.shortcutHelp'))}</div>
      <input type="text" id="sc" value="${esc(cfg.shortcut)}" />
      <div class="msg" id="sc-msg"></div>
    </div>
    <div class="field">
      <label class="switch"><input type="checkbox" id="alerts-on" ${(cfg.alerts || {}).enabled !== false ? 'checked' : ''} />
        ${esc(t('set.alerts'))}</label>
      <div class="help" style="margin-top:6px">${esc(t('set.alertsHelp'))}</div>
      <div class="row2" style="margin-top:6px">
        <input type="text" id="alerts-th" value="${esc(((cfg.alerts || {}).thresholds || [80, 95]).join(', '))}"
               aria-label="${esc(t('set.thresholdsAria'))}" placeholder="80, 95" />
        <span class="faint">${esc(t('set.thresholdsUnit'))}</span>
      </div>
      <label class="switch" style="margin-top:8px"><input type="checkbox" id="alerts-proj" ${(cfg.alerts || {}).projection !== false ? 'checked' : ''} />
        ${esc(t('set.projection'))}</label>
      <div class="help" style="margin-top:6px">${t('set.projectionHelp')}</div>
    </div>
    <div class="field">
      <label for="grid">${esc(t('set.grid'))}</label>
      <div class="help">${esc(t('set.gridHelp'))}</div>
      <select id="grid">${gridOptions().map(([k, l]) => `<option value="${k}" ${(cfg.carbon || {}).gridKey === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="field">
      <label for="tray">${esc(t('set.tray'))}</label>
      <select id="tray">
        ${[['session', t('set.trayMetric.session')], ['tokens', t('metric.tokens')], ['cost', t('metric.cost')], ['carbon', t('metric.carbon')]]
          .map(([k, l]) => `<option value="${k}" ${cfg.trayMetric === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="interval">${esc(t('set.interval'))}</label>
      <div class="row2"><input type="number" id="interval" min="15" max="3600" value="${cfg.refreshIntervalSec}" /><span class="faint">${esc(t('set.seconds'))}</span></div>
    </div>
    <div class="field">
      <label for="compact">${esc(t('set.compact'))}</label>
      <div class="help">${esc(t('set.compactHelp'))}</div>
      <div class="row2"><input type="number" id="compact" min="0" max="1095" value="${Number(cfg.compactAfterDays) || 0}" /><span class="faint">${esc(t('set.days'))}</span></div>
    </div>
    <div class="field">
      <label class="switch"><input type="checkbox" id="login" ${cfg.launchAtLogin ? 'checked' : ''} /> ${esc(t('set.launch'))}</label>
    </div>
    <div class="field">
      <label class="switch"><input type="checkbox" id="updates" ${cfg.checkUpdates !== false ? 'checked' : ''} />
        ${esc(t('set.updates'))}</label>
      <div class="help" style="margin-top:6px">${esc(t('set.updatesHelp'))}</div>
    </div>
    <div class="field">
      <label for="ak">${esc(t('set.anthropicKey'))}</label>
      <div class="help">${esc(t('set.anthropicKeyHelp'))}
        ${cfg.encryptionAvailable ? esc(t('set.keychainOk')) : `<strong class="c-hot">${esc(t('set.keychainKo'))}</strong>`}</div>
      <div class="row2"><input type="password" id="ak" placeholder="${esc(cfg.anthropicAdminKey ? t('set.keyStored') : 'sk-ant-admin…')}" />
        <button class="btn" id="save-ak">${esc(t('ui.save'))}</button></div>
      <div class="msg" id="ak-msg"></div>
    </div>
    <div class="field">
      <label for="ok">${esc(t('set.openaiKey'))}</label>
      <div class="help">${esc(t('set.openaiKeyHelp'))}</div>
      <div class="row2"><input type="password" id="ok" placeholder="${esc(cfg.openaiAdminKey ? t('set.keyStored') : 'sk-admin-…')}" />
        <button class="btn" id="save-ok">${esc(t('ui.save'))}</button></div>
      <div class="msg" id="ok-msg"></div>
    </div>
    <div class="field" style="display:flex;gap:8px">
      <button class="btn primary" id="save-settings">${esc(t('ui.apply'))}</button>
      <span class="spacer" style="margin-left:auto"></span>
      <button class="btn" id="quit">${esc(t('ui.quit'))}</button>
    </div>`;

  const saveKey = (btn, provider, inputId, msgId) =>
    withPending(btn, t('ui.sending'), async () => {
      const input = document.getElementById(inputId);
      const msg = document.getElementById(msgId);
      const res = await window.trace.setKey(provider, input.value.trim() || null);
      msg.textContent = res.ok ? t('set.keySaved') : res.error;
      msg.className = `msg ${res.ok ? 'c-carbon' : 'c-hot'}`;
      if (res.ok) input.value = '';
    });
  $('#save-ak').onclick = (e) => saveKey(e.currentTarget, 'anthropic', 'ak', 'ak-msg');
  $('#save-ok').onclick = (e) => saveKey(e.currentTarget, 'openai', 'ok', 'ok-msg');
  $('#quit').onclick = () => window.trace.quit();

  $('#save-settings').onclick = (e) =>
    withPending(e.currentTarget, t('ui.applying'), async () => {
      const thresholds = $('#alerts-th').value.split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v) && v > 0 && v <= 100)
        .sort((a, b) => a - b);

      const res = await window.trace.setConfig({
        alerts: {
          enabled: $('#alerts-on').checked,
          thresholds: thresholds.length ? thresholds : [80, 95],
          projection: $('#alerts-proj').checked,
        },
        locale: $('#lang').value,
        compactAfterDays: Math.max(0, Number($('#compact').value) || 0),
        checkUpdates: $('#updates').checked,
        shortcut: $('#sc').value.trim(),
        carbon: { ...(cfg.carbon || {}), gridKey: $('#grid').value },
        trayMetric: $('#tray').value,
        refreshIntervalSec: Number($('#interval').value) || 60,
        launchAtLogin: $('#login').checked,
      });
      // Un raccourci refusé — déjà pris par une autre application, ou de
      // syntaxe invalide — partait auparavant dans un `console.warn` que
      // personne ne lit, laissant un raccourci silencieusement inopérant.
      if (res && res.shortcutOk === false) {
        const msg = $('#sc-msg');
        msg.textContent = t('set.shortcutRefused');
        msg.className = 'msg c-hot';
        return;
      }
      // Changer de langue change tout l'écran, jusqu'aux libellés calculés
      // par le cœur : on reprend le catalogue et l'instantané avant de
      // repeindre, sinon la moitié de la page resterait dans l'ancienne.
      if ((cfg.locale || 'auto') !== $('#lang').value) {
        initI18n(await window.trace.getStrings());
        applyStaticI18n();
        snap = await window.trace.getSnapshot({ days });
        render();
      }
      $('#settings').close();
      toast(t('ui.settingsApplied'));
    });

  $('#settings').showModal();
}

// ---------------------------------------------------------------------------

/**
 * Retour d'action.
 *
 * Plusieurs actions étaient totalement muettes — l'export notamment ne disait
 * ni qu'il travaillait, ni où le fichier avait atterri, ni qu'il avait échoué.
 * Une action sans réponse est indiscernable d'une action cassée.
 */
let toastTimer = null;
function toast(message, kind = 'ok') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast ${kind} shown`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('shown'), kind === 'error' ? 7000 : 4000);
}

/** Exécute une action en désactivant son bouton le temps qu'elle dure. */
async function withPending(button, label, fn) {
  if (button.disabled) return;
  const previous = button.textContent;
  button.disabled = true;
  button.classList.add('pending');
  if (label) button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.classList.remove('pending');
    if (label) button.textContent = previous;
  }
}

$('#range-seg').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  days = b.dataset.days === 'all' ? 'all' : Number(b.dataset.days);
  snap = await window.trace.getSnapshot({ days });
  render();
};
$('#refresh').onclick = (e) =>
  withPending(e.currentTarget, null, async () => {
    const before = snap && snap.liveStatus ? snap.liveStatus.ageMs : null;
    snap = await window.trace.refresh();
    render();

    // Une action ne doit jamais rester sans réponse. Un report en cours
    // empêche le relevé : le dire, plutôt que de laisser croire à une panne.
    const ls = snap.liveStatus;
    if (ls && ls.waiting) {
      toast(t('toast.liveWaiting', { n: Math.ceil(ls.nextAttemptIn / 60000), error: ls.error }), 'error');
    } else if (ls && !ls.ok) {
      toast(t('toast.liveDown', { error: ls.error }), 'error');
    } else if (ls && before != null && ls.ageMs >= before) {
      toast(t('toast.alreadyFresh'));
    } else {
      toast(t('toast.refreshed'));
    }
  });

$('#export').onclick = (e) =>
  withPending(e.currentTarget, null, async () => {
    const res = await window.trace.exportCsv({ days });
    if (res.canceled) return;
    if (res.ok) toast(t('toast.exported', { n: nf(res.rows), file: res.filePath.split('/').pop() }));
    else toast(res.error, 'error');
  });
$('#settings-btn').onclick = openSettings;
$('#close-settings').onclick = () => $('#settings').close();

window.trace.onUpdate((payload) => { snap = payload; requestRender(); });
// Un redimensionnement émet des dizaines d'événements par seconde ; chacun
// déclenchait un rendu complet avec régénération de tous les SVG. On coalesce
// sur une frame d'affichage : au plus un rendu par rafraîchissement écran.
let resizePending = false;
window.addEventListener('resize', () => {
  if (resizePending || !snap) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    render();
  });
});

(async () => {
  // Le catalogue AVANT le premier rendu : peindre puis corriger ferait
  // clignoter l'écran sur des clés brutes.
  initI18n(await window.trace.getStrings());
  applyStaticI18n();
  // `lang` pilote la césure et la ponctuation du navigateur : le laisser à
  // « fr » sur une page anglaise produit des espaces insécables avant les
  // deux-points là où l'anglais n'en veut pas.
  document.documentElement.lang = lang();
  snap = await window.trace.getSnapshot({ days });
  render();
  setInterval(() => { if (snap && !snap.staleError) $('#updated').textContent = ago(snap.generatedAt); }, 5000);
})();
