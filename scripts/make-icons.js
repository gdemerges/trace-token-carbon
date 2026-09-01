#!/usr/bin/env node
'use strict';

/** Génère les icônes d'empaquetage. Aucun binaire n'est versionné : elles sont
 *  redessinées à chaque build depuis `src/main/icon.js`. */
const fs = require('fs');
const path = require('path');
const { drawAppIcon } = require('../src/main/icon');

const dir = path.join(__dirname, '..', 'build');
fs.mkdirSync(dir, { recursive: true });
for (const size of [512, 1024]) {
  const file = path.join(dir, size === 1024 ? 'icon.png' : `icon-${size}.png`);
  fs.writeFileSync(file, drawAppIcon(size));
  console.log(`${path.relative(process.cwd(), file)} — ${size}×${size}`);
}
