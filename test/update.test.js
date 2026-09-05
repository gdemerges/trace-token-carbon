'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { compareVersions, pickRelease, fetchLatest, startUpdateChecks } = require('../src/main/update');

test('versions : comparaison numérique, champ par champ', () => {
  assert.ok(compareVersions('1.2.0', '1.1.9') > 0);
  assert.ok(compareVersions('0.2.0', '0.10.0') < 0, '10 est postérieur à 2, pas l’inverse');
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('v1.0.1', '1.0.0') > 0, 'le préfixe v est toléré');
});

test('versions : une pré-version est antérieure à la stable de même numéro', () => {
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.2') > 0);
});

test('versions : un format inconnu ne déclenche rien', () => {
  assert.equal(compareVersions('nightly', '1.0.0'), 0);
  assert.equal(pickRelease({ tag_name: 'nightly' }, '0.1.0'), null);
});

test('mise à jour : seule une version stable et postérieure est annoncée', () => {
  const base = { html_url: 'https://github.com/gdemerges/trace-token-carbon/releases/tag/v0.2.0' };
  assert.ok(pickRelease({ ...base, tag_name: 'v0.2.0' }, '0.1.0'));
  assert.equal(pickRelease({ ...base, tag_name: 'v0.1.0' }, '0.1.0'), null, 'même version : rien à dire');
  assert.equal(pickRelease({ ...base, tag_name: 'v0.0.9' }, '0.1.0'), null, 'antérieure : rien à dire');
  assert.equal(pickRelease({ ...base, tag_name: 'v0.2.0', prerelease: true }, '0.1.0'), null);
  assert.equal(pickRelease({ ...base, tag_name: 'v0.2.0', draft: true }, '0.1.0'), null);
  assert.equal(pickRelease(null, '0.1.0'), null);
});

test('mise à jour : une URL qui ne vient pas de GitHub est remplacée', () => {
  // La réponse est une donnée distante : on ne clique pas sur ce qu'elle dit
  // sans vérifier d'où ça vient.
  const found = pickRelease({ tag_name: 'v9.9.9', html_url: 'https://ailleurs.example/piege' }, '0.1.0');
  assert.ok(found.url.startsWith('https://github.com/gdemerges/trace-token-carbon'));
});

test('mise à jour : une panne réseau ne remonte pas d’erreur', async () => {
  assert.equal(await fetchLatest(async () => { throw new Error('offline'); }), null);
  assert.equal(await fetchLatest(async () => ({ ok: false, status: 503 })), null);
});

test('mise à jour : le réglage coupé n’émet aucun appel', async () => {
  let appels = 0;
  const stop = startUpdateChecks({
    version: '0.1.0',
    isEnabled: () => false,
    notify: () => assert.fail('rien ne doit être notifié'),
    fetchImpl: async () => { appels++; return { ok: true, json: async () => ({}) }; },
  });
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.equal(appels, 0);
});
