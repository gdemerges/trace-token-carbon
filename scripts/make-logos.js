#!/usr/bin/env node
'use strict';

/**
 * Intègre les logos de `logo/` dans un module JavaScript.
 *
 * Pourquoi les embarquer en base64 plutôt que les charger comme fichiers :
 * le popover et le tableau de bord vivent dans des dossiers différents, et
 * l'empaquetage Electron déplace les ressources. Une donnée en ligne n'a ni
 * chemin relatif à gérer, ni requête à faire — et à cette taille, le coût est
 * négligeable.
 *
 * Les logos sont rendus en MASQUE CSS, pas en image : ce sont des silhouettes
 * monochromes, et un masque laisse la couleur s'adapter au thème. Le noir du
 * logo OpenAI serait invisible sur fond sombre.
 *
 * Déposez un fichier dans `logo/` et relancez ce script pour l'ajouter.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'logo');
const OUT = path.join(ROOT, 'src', 'renderer', 'shared', 'logos.js');
const SIZE = 96;

// Reconnaissance par nom de fichier : tolérante, pour que l'ajout d'un logo ne
// demande pas d'éditer ce script.
const PROVIDERS = [
  { id: 'anthropic', match: /claude|anthropic/i, color: '#d97757', note: 'terracotta de la marque, lisible sur fond clair comme sombre' },
  { id: 'openai', match: /openai|chatgpt|gpt/i, color: 'currentColor', note: 'marque monochrome : noir sur clair, blanc sur sombre, comme son usage officiel' },
  { id: 'google', match: /gemini|google/i, color: '#b79bff', note: null },
  { id: 'local', match: /ollama|llama/i, color: '#f0a3bd', note: null },
];

function toPng(file, size) {
  const tmp = path.join(require('os').tmpdir(), `trace-logo-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  // `sips` est présent sur macOS ; ailleurs on exige déjà un PNG à la bonne taille.
  try {
    execFileSync('sips', ['-s', 'format', 'png', '-Z', String(size), file, '--out', tmp], { stdio: 'ignore' });
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buf;
  } catch {
    if (/\.png$/i.test(file)) return fs.readFileSync(file);
    throw new Error(`Impossible de convertir ${path.basename(file)} — fournissez un PNG.`);
  }
}

function main() {
  let files = [];
  try {
    files = fs.readdirSync(SRC).filter((f) => /\.(png|webp|jpg|jpeg)$/i.test(f));
  } catch {
    console.error(`Dossier ${SRC} introuvable — aucun logo intégré.`);
  }

  const entries = [];
  for (const f of files) {
    const provider = PROVIDERS.find((p) => p.match.test(f));
    if (!provider) {
      console.warn(`  ignoré : ${f} (aucun fournisseur reconnu dans le nom)`);
      continue;
    }
    if (entries.some((e) => e.id === provider.id)) {
      console.warn(`  ignoré : ${f} (${provider.id} déjà fourni)`);
      continue;
    }
    const buf = toPng(path.join(SRC, f), SIZE);
    entries.push({ ...provider, source: f, b64: buf.toString('base64'), bytes: buf.length });
    console.log(`  ${provider.id.padEnd(10)} ← ${f} (${(buf.length / 1024).toFixed(1)} ko)`);
  }

  const body = entries
    .map(
      (e) => `  ${e.id}: {
    // Source : logo/${e.source}${e.note ? `\n    // ${e.note}` : ''}
    color: '${e.color}',
    url: 'data:image/png;base64,${e.b64}',
  },`
    )
    .join('\n');

  fs.writeFileSync(
    OUT,
    `/**
 * Logos de fournisseurs — GÉNÉRÉ, ne pas modifier à la main.
 * Régénérez avec \`npm run logos\` après avoir déposé un fichier dans \`logo/\`.
 *
 * Rendus en masque CSS et non en image : ce sont des silhouettes monochromes,
 * et le masque laisse la couleur suivre le thème.
 */

export const LOGOS = {
${body}
};
`
  );
  console.log(`\n${path.relative(ROOT, OUT)} — ${entries.length} logo(s), ${(fs.statSync(OUT).size / 1024).toFixed(1)} ko`);
}

main();
