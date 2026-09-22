import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initI18n, t, lang, intl } from '../src/renderer/shared/i18n.js';
import { useLocale } from './helpers.mjs';

test('une clé absente se rend telle quelle, jamais vide', () => {
  useLocale('fr');
  assert.equal(t('cle.qui.n.existe.pas'), 'cle.qui.n.existe.pas');
});

test('les paramètres sont interpolés, les inconnus laissés visibles', () => {
  initI18n({ locale: 'fr', intlLocale: 'fr-FR', strings: { k: '{a} et {b}' } });
  assert.equal(t('k', { a: 'x' }), 'x et {b}');
});

test('le pluriel suit la règle de la langue', () => {
  useLocale('fr');
  assert.equal(t('recon.days', { n: 1 }), '1 jour');
  assert.equal(t('recon.days', { n: 3 }), '3 jours');
});

test('le catalogue fixe la langue et le format Intl', () => {
  // Le pont IPC envoie `locale` et `intlLocale` : sans eux, l'interface
  // anglaise formatait les nombres à la française.
  useLocale('en');
  assert.equal(lang(), 'en');
  assert.equal(intl(), 'en-US');
});
