'use strict';

/**
 * Produit l'instantané de développement que sert la coquille Tauri tant que le
 * cœur n'est pas porté.
 *
 * Le fichier reste HORS du dépôt : il porte vos noms de projets et vos
 * volumétries réelles, et le dépôt est public. Chacun régénère le sien sur sa
 * machine ; en son absence, l'application affiche l'état vide, qui est un cas
 * de rendu à éprouver de toute façon.
 */
const fs = require('fs');
const path = require('path');
const core = require('../src/core');

const OUT = path.join(__dirname, '..', 'src-tauri', 'fixtures', 'snapshot.dev.json');

(async () => {
  const state = await core.refresh({ quiet: true });
  const snap = core.snapshot(state, { days: 30 });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snap, null, 1));
  console.log(`${OUT} — ${snap.report.eventCount} événements, ${snap.gauges.length} jauges`);
})();
