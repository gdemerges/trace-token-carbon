#!/usr/bin/env node
'use strict';

/**
 * TRACE en ligne de commande.
 *
 * Le raccourci global et le popover couvrent le coup d'œil depuis n'importe
 * quelle application ; cette CLI couvre le cas où l'on est déjà dans un
 * terminal et où ouvrir une fenêtre serait plus lent que taper trois lettres.
 * Elle partage exactement le même cœur métier et le même index que l'app.
 */

const core = require('./core');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', off: '\x1b[0m', b: '\x1b[1m', amber: '\x1b[38;5;214m', teal: '\x1b[38;5;79m', blue: '\x1b[38;5;111m', red: '\x1b[38;5;203m' }
  : { dim: '', off: '', b: '', amber: '', teal: '', blue: '', red: '' };

const nf = (n, d = 0) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
const tok = (n) => (n >= 1e9 ? `${nf(n / 1e9, 2)} Md` : n >= 1e6 ? `${nf(n / 1e6, 1)} M` : n >= 1e3 ? `${nf(n / 1e3, 1)} k` : nf(n));
const co2 = (g) => (g >= 1e6 ? `${nf(g / 1e6, 2)} t` : g >= 1000 ? `${nf(g / 1000, 1)} kg` : `${nf(g, 1)} g`);
const usd = (n) => (n == null ? '—' : n >= 1000 ? `$${nf(n)}` : `$${nf(n, 2)}`);

/** Jauge en blocs, même vocabulaire visuel que l'interface graphique. */
function bar(percent, width = 24) {
  if (percent == null) return C.dim + '─'.repeat(width) + C.off;
  const filled = Math.round((Math.min(100, percent) / 100) * width);
  const color = percent >= 85 ? C.red : C.amber;
  return color + '█'.repeat(filled) + C.off + C.dim + '░'.repeat(width - filled) + C.off;
}

function until(ts) {
  if (!ts) return null;
  const ms = ts - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h / 24)} j` : h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const daysArg = args.find((a) => /^--days=\d+$/.test(a));
  const days = daysArg ? Number(daysArg.split('=')[1]) : 30;

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`TRACE — consommation de tokens, limites et empreinte carbone

  trace              jauges et totaux sur 30 jours
  trace --days=7     change la période
  trace --json       sortie machine, pour un script ou une barre de statut
  trace --models     détail par modèle
  trace --sources    état des sources de données
`);
    return;
  }

  const state = await core.refresh();
  const snap = core.snapshot(state, { days });
  const t = snap.report.totals;

  if (json) {
    console.log(JSON.stringify({
      generatedAt: snap.generatedAt,
      days,
      tokens: t.tokens.total,
      requests: t.requests,
      costUSD: Number(t.costUSD.toFixed(4)),
      cacheSavingsUSD: Number(t.cacheSavingsUSD.toFixed(4)),
      gramsCO2e: { min: t.carbon.gramsCO2e.min, mid: t.carbon.gramsCO2e.mid, max: t.carbon.gramsCO2e.max },
      energyWh: t.carbon.energyWh.mid,
      gauges: snap.gauges.map((g) => ({ id: g.id, label: g.label, percent: g.percent, resetsAt: g.resetsAt, limitSource: g.limitSource })),
    }, null, 2));
    return;
  }

  console.log('');
  for (const g of snap.gauges) {
    const pctStr = g.percent == null ? '  —' : `${g.approximate ? '≈' : ' '}${String(Math.round(g.percent)).padStart(3)}%`;
    const left = until(g.resetsAt);
    // Même règle que l'interface : on ne cite l'âge d'un relevé que s'il est
    // encore ce qu'on affiche. Une fenêtre expirée a été recalculée depuis.
    const note = left
      ? `réinit. ${left}`
      : C.dim +
        (g.limitSource === 'provider' ? 'relevé ancien'
          : g.limitSource === 'reset' ? 'réinitialisée'
          : g.limitSource === 'live' ? 'en direct'
          : g.limitSource === 'live-stale' ? 'relevé daté, reprise en cours'
          : g.limitSource === 'derived' ? 'déduit du dernier relevé'
          : g.limitSource === 'user' ? 'calé par vous'
          : 'glissante') +
        C.off;
    console.log(` ${C.b}${g.label.padEnd(21)}${C.off} ${bar(g.percent)} ${pctStr}  ${note}`);
  }

  const c = t.carbon.gramsCO2e;
  console.log('');
  console.log(` ${C.dim}${String(days).padStart(2)} jours${C.off}   ${C.amber}${tok(t.tokens.total).padEnd(9)}${C.off} ${C.dim}tokens${C.off}   ${C.blue}${usd(t.costUSD).padEnd(9)}${C.off} ${C.dim}coût${C.off}   ${C.teal}${co2(c.mid).padEnd(8)}${C.off} ${C.dim}CO₂e${C.off}`);
  console.log(` ${C.dim}          ${nf(t.requests).padEnd(9)} requêtes  ${usd(t.cacheSavingsUSD).padEnd(9)} évités   ${co2(c.min)} – ${co2(c.max)}${C.off}`);

  if (args.includes('--models')) {
    console.log('');
    for (const m of snap.report.byModel) {
      const share = (m.tokens.total / (t.tokens.total || 1)) * 100;
      console.log(` ${m.models[0].label.padEnd(22)} ${tok(m.tokens.total).padStart(9)}  ${String(nf(share, 1) + ' %').padStart(7)}  ${usd(m.costUSD).padStart(9)}  ${co2(m.carbon.gramsCO2e.mid).padStart(8)}`);
    }
  }

  if (args.includes('--sources')) {
    console.log('');
    for (const s of snap.sources) {
      const mark = s.error ? C.red + '✗' + C.off : s.eventsInRange ? C.teal + '●' + C.off : C.dim + '○' + C.off;
      const detail = s.error || s.note || `${nf(s.eventsInRange)} requêtes sur la période`;
      console.log(` ${mark} ${s.label.padEnd(30)} ${C.dim}${detail}${C.off}`);
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error('TRACE :', e.message);
  process.exit(1);
});
