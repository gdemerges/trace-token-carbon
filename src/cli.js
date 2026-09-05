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
const i18n = require('./i18n');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', off: '\x1b[0m', b: '\x1b[1m', amber: '\x1b[38;5;214m', teal: '\x1b[38;5;79m', blue: '\x1b[38;5;111m', red: '\x1b[38;5;203m' }
  : { dim: '', off: '', b: '', amber: '', teal: '', blue: '', red: '' };

// La langue se fixe avant tout : les libellés de jauges et de sources sont
// construits dans le cœur, pas ici. `--lang=` l'emporte, sinon l'environnement
// (LC_ALL, LANG), sinon le réglage enregistré.
const langArg = process.argv.slice(2).find((a) => /^--lang=/.test(a));
const envLang = process.env.LC_ALL || process.env.LANGUAGE || process.env.LANG || '';
const LOCALE = i18n.setLocale(
  i18n.resolveLocale(langArg ? langArg.split('=')[1] : core.store.loadConfig().locale, envLang)
);
const t = i18n.t;
const INTL = i18n.currentLocale().intlLocale;

const nf = (n, d = 0) => new Intl.NumberFormat(INTL, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
const tok = (n) => (n >= 1e9 ? `${nf(n / 1e9, 2)} Md` : n >= 1e6 ? `${nf(n / 1e6, 1)} M` : n >= 1e3 ? `${nf(n / 1e3, 1)} k` : nf(n));
const co2 = (g) => (g >= 1e6 ? `${nf(g / 1e6, 2)} t` : g >= 1000 ? `${nf(g / 1000, 1)} kg` : `${nf(g, 1)} g`);
const usd = (n) => (n == null ? '—' : n >= 1000 ? `$${nf(n)}` : `$${nf(n, 2)}`);
const wat = (l) => (l >= 1000 ? `${nf(l / 1000, 1)} m³` : l >= 1 ? `${nf(l, 1)} L` : `${nf(l * 1000)} mL`);

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
  if (h >= 24) return t('duration.days', { n: Math.floor(h / 24) });
  if (h > 0) return t('duration.hoursMinutes', { h, m: String(m).padStart(2, '0') });
  return t('duration.minutes', { n: m });
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const daysArg = args.find((a) => /^--days=(\d+|all)$/.test(a));
  const raw = daysArg ? daysArg.split('=')[1] : '30';
  const days = raw === 'all' ? 'all' : Number(raw);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(t('cli.help'));
    return;
  }

  // L'index appartient à l'application tant qu'elle tourne. `saveIndex` le
  // vérifie de lui-même, mais le dire ici documente le contrat : la CLI lit
  // les mêmes chiffres et n'écrit que si la place est libre.
  const state = await core.refresh();
  const snap = core.snapshot(state, { days });
  const tot = snap.report.totals;

  if (json) {
    console.log(JSON.stringify({
      generatedAt: snap.generatedAt,
      days: snap.range.days,
      from: snap.range.from,
      dataHorizon: snap.dataHorizon.from,
      locale: LOCALE,
      tokens: tot.tokens.total,
      requests: tot.requests,
      costUSD: Number(tot.costUSD.toFixed(4)),
      cacheSavingsUSD: Number(tot.cacheSavingsUSD.toFixed(4)),
      gramsCO2e: { min: tot.carbon.gramsCO2e.min, mid: tot.carbon.gramsCO2e.mid, max: tot.carbon.gramsCO2e.max },
      energyWh: tot.carbon.energyWh.mid,
      waterL: tot.carbon.waterL.mid,
      // Le total seul n'est pas exploitable dans un bilan : on livre aussi de
      // quoi le contester, sans quoi un script se contenterait de la médiane.
      sensitivity: tot.carbonSensitivity.map((r) => ({ grid: r.key, gCO2ePerKWh: r.intensity, gramsCO2e: r.gramsCO2e.mid, ratio: r.ratio })),
      uncertainty: tot.carbonUncertainty.map((l) => ({ lever: l.key, label: l.label, ratio: l.ratio })),
      gauges: snap.gauges.map((g) => ({
        id: g.id,
        label: g.label,
        percent: g.percent,
        resetsAt: g.resetsAt,
        limitSource: g.limitSource,
        // Une barre de statut veut savoir s'il faut lever le pied, pas
        // seulement où l'on en est : la trajectoire part avec le niveau.
        saturatesAt: g.projection && g.projection.beforeReset ? g.projection.at : null,
      })),
      reconciliation: (snap.report.reconciliation || []).map((r) => ({
        family: r.family, local: r.local, billed: r.billed, deltaPct: r.deltaPct, days: r.days.length,
      })),
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
      ? t('cli.resetIn', { when: left })
      : C.dim +
        (g.limitSource === 'provider' ? t('cli.origin.provider')
          : g.limitSource === 'reset' ? t('cli.origin.reset')
          : g.limitSource === 'live' ? t('cli.origin.live')
          : g.limitSource === 'live-stale' ? t('cli.origin.liveStale')
          : g.limitSource === 'derived' ? t('cli.origin.derived')
          : g.limitSource === 'user' ? t('cli.origin.user')
          : t('cli.origin.rolling')) +
        C.off;
    // La trajectoire ne s'affiche que si la saturation précède la
    // réinitialisation : sinon la fenêtre se vide d'abord, et l'annoncer
    // ferait passer un régime normal pour un avertissement.
    const p = g.projection;
    const proj = p && p.beforeReset
      ? `  ${C.red}${t('cli.full', { when: until(p.at) || t('cli.underMinute') })}${C.off}`
      : '';
    console.log(` ${C.b}${(g.fullLabel || g.label).padEnd(21)}${C.off} ${bar(g.percent)} ${pctStr}  ${note}${proj}`);
  }

  const c = tot.carbon.gramsCO2e;
  console.log('');
  console.log(` ${C.dim}${String(snap.range.days).padStart(3)} ${t('cli.days')}${C.off}   ${C.amber}${tok(tot.tokens.total).padEnd(9)}${C.off} ${C.dim}${t('cli.tokens')}${C.off}   ${C.blue}${usd(tot.costUSD).padEnd(9)}${C.off} ${C.dim}${t('cli.cost')}${C.off}   ${C.teal}${co2(c.mid).padEnd(8)}${C.off} ${C.dim}CO₂e${C.off}`);
  console.log(` ${C.dim}          ${nf(tot.requests).padEnd(9)} ${t('cli.requests')}  ${usd(tot.cacheSavingsUSD).padEnd(9)} ${t('cli.saved')}   ${co2(c.min)} – ${co2(c.max)}${C.off}`);

  // Le détail carbone ne s'affiche que sur demande : la vue par défaut tient
  // en un écran, et la sensibilité n'intéresse qu'au moment de rédiger un bilan.
  if (args.includes('--carbone')) {
    console.log('');
    console.log(` ${C.dim}${t('cli.water')}${C.off}     ${wat(tot.carbon.waterL.mid).padEnd(10)} ${C.dim}${wat(tot.carbon.waterL.min)} – ${wat(tot.carbon.waterL.max)}${C.off}`);
    console.log('');
    console.log(` ${C.dim}${t('cli.elsewhere')}${C.off}`);
    for (const r of tot.carbonSensitivity) {
      console.log(`   ${r.label.padEnd(24)} ${String(nf(r.intensity) + ' g/kWh').padStart(11)}   ${co2(r.gramsCO2e.mid).padStart(9)}   ${C.dim}× ${nf(r.ratio, 2)}${C.off}`);
    }
    console.log('');
    console.log(` ${C.dim}${t('cli.uncertainty')}${C.off}`);
    for (const l of tot.carbonUncertainty) {
      console.log(`   ${l.label.padEnd(24)} ${('× ' + nf(l.ratio, 1)).padStart(11)}   ${C.dim}${l.note}${C.off}`);
    }
  }

  if (args.includes('--models')) {
    console.log('');
    for (const m of snap.report.byModel) {
      const share = (m.tokens.total / (tot.tokens.total || 1)) * 100;
      console.log(` ${m.models[0].label.padEnd(22)} ${tok(m.tokens.total).padStart(9)}  ${String(nf(share, 1) + ' %').padStart(7)}  ${usd(m.costUSD).padStart(9)}  ${co2(m.carbon.gramsCO2e.mid).padStart(8)}`);
    }
  }

  if (args.includes('--sources')) {
    console.log('');
    for (const s of snap.sources) {
      const mark = s.error ? C.red + '✗' + C.off : s.eventsInRange ? C.teal + '●' + C.off : C.dim + '○' + C.off;
      const detail = s.error || s.note || t('cli.requestsInRange', { n: nf(s.eventsInRange) });
      console.log(` ${mark} ${s.label.padEnd(30)} ${C.dim}${detail}${C.off}`);
    }

    // Mesure locale contre facture : la seule vérification externe possible.
    for (const r of snap.report.reconciliation || []) {
      const ecart = Math.abs(r.deltaPct);
      const sens = r.deltaPct >= 0 ? t('cli.more') : t('cli.less');
      console.log(
        `   ${C.dim}${r.family.padEnd(28)}${C.off} ${t('cli.recon', { local: tok(r.local), billed: tok(r.billed) })} ` +
        `${ecart >= 5 ? C.red : C.dim}${t('cli.reconDelta', { pct: nf(ecart, 1), dir: sens, days: r.days.length })}${C.off}`
      );
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error(t('cli.error'), e.message);
  process.exit(1);
});
