import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, tokens, usd, co2, water, pct, ago, until } from '../src/renderer/shared/format.js';
import { useLocale } from './helpers.mjs';

test('esc neutralise les cinq caractères du HTML', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(esc(null), '');
  assert.equal(esc(42), '42');
});

test('un nom de projet hostile ressort inerte', () => {
  // Les noms de projets viennent des journaux : c'est l'entrée non fiable.
  const hostile = '</span><script>alert(1)</script>';
  assert.ok(!esc(hostile).includes('<'));
});

test('les volumes de tokens gardent deux ou trois chiffres significatifs', () => {
  useLocale('en');
  assert.equal(tokens(1_304_649_958), '1.30 Md');
  assert.equal(tokens(4_400_000), '4.4 M');
  assert.equal(tokens(12_300), '12.3 k');
  assert.equal(tokens(999), '999');
  assert.equal(tokens(undefined), '0');
});

test('la langue change le séparateur, pas l\'unité', () => {
  useLocale('fr');
  assert.equal(tokens(4_400_000), '4,4 M');
  useLocale('en');
  assert.equal(tokens(4_400_000), '4.4 M');
});

test('le coût adapte sa précision à son ordre de grandeur', () => {
  useLocale('en');
  assert.equal(usd(null), '—');
  assert.equal(usd(1234.5), '$1,235');
  assert.equal(usd(12.345), '$12.35');
  assert.equal(usd(0.05), '$0.050');
  assert.equal(usd(0.001), '$0.0010');
});

test('masse et volume changent d\'unité avec l\'ordre de grandeur', () => {
  useLocale('en');
  assert.equal(co2(0.5), '500 mg');
  assert.equal(co2(12), '12.0 g');
  assert.equal(co2(2500), '2.5 kg');
  assert.equal(co2(3_000_000), '3.00 t');
  assert.equal(water(0.002), '2 mL');
  assert.equal(water(2500), '2.5 m³');
});

test('un pourcentage absent ne devient pas zéro', () => {
  assert.equal(pct(null), '—');
});

test('les durées se disent dans la langue retenue', () => {
  useLocale('fr');
  assert.equal(ago(Date.now()), "à l'instant");
  assert.equal(ago(Date.now() - 5 * 60_000), 'il y a 5 min');
});

test('une échéance passée ne s\'annonce pas', () => {
  assert.equal(until(Date.now() - 1000), null);
  assert.equal(until(0), null);
  assert.notEqual(until(Date.now() + 2 * 3_600_000), null);
});
