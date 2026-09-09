#!/usr/bin/env node
'use strict';

/**
 * Génère les icônes que Tauri exige, depuis le même dessin que la version
 * Electron : `src/main/icon.js`, un encodeur PNG écrit à la main, sans
 * dépendance ni fichier binaire d'origine.
 *
 * Windows a besoin d'un `.ico` : `tauri-build` l'incorpore comme ressource
 * binaire de l'exécutable, et sans lui la compilation échoue — pas au lien,
 * mais au script de construction, avec un message qu'on ne voit que sur cette
 * plateforme. C'est exactement le genre d'écart qu'une CI trois-systèmes
 * existe pour attraper.
 *
 * Le `.ico` produit encapsule un PNG : le format l'autorise depuis Vista, et
 * cela évite d'écrire un encodeur BMP en plus.
 */
const fs = require('fs');
const path = require('path');
const { drawAppIcon, drawTrayIcon } = require('../src/main/icon');

const dir = path.join(__dirname, '..', 'src-tauri', 'icons');
fs.mkdirSync(dir, { recursive: true });

/** Encapsule des PNG dans un conteneur ICO. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // réservé
  header.writeUInt16LE(1, 2); // type : icône
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    // 0 signifie 256 : le champ ne tient que sur un octet.
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette : aucune
    e.writeUInt8(0, 3); // réservé
    e.writeUInt16LE(1, 4); // plans
    e.writeUInt16LE(32, 6); // bits par pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const written = [];
const write = (name, buf) => {
  fs.writeFileSync(path.join(dir, name), buf);
  written.push(`${name} — ${(buf.length / 1024).toFixed(1)} ko`);
};

// Les tailles que Tauri attend pour l'empaquetage des trois systèmes.
for (const size of [32, 128, 256, 512]) {
  write(size === 256 ? '128x128@2x.png' : `${size}x${size}.png`, drawAppIcon(size));
}
write('icon.png', drawAppIcon(1024));
write('icon.ico', ico([32, 64, 256].map((size) => ({ size, png: drawAppIcon(size) }))));
// L'icône de barre d'état, en gabarit : le système la teinte selon le thème.
write('tray.png', (drawTrayIcon || drawAppIcon)(44));
write('tray@2x.png', (drawTrayIcon || drawAppIcon)(88));

console.log(written.join('\n'));
