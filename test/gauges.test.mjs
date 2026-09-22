import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByProduct, originText, projectionLabel } from '../src/renderer/shared/gauges.js';
import { useLocale } from './helpers.mjs';

useLocale('fr');

const gauge = (over) => ({ product: 'Claude', provider: 'anthropic', percent: null, limitSource: null, ...over });

test('les jauges d\'un même produit forment un seul bloc', () => {
  const blocks = groupByProduct([gauge({ id: 'a' }), gauge({ id: 'b' }), gauge({ product: 'Codex', provider: 'openai' })]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks.find((b) => b.product === 'Claude').gauges.length, 2);
});

test('le relevé en direct passe devant, puis les échelles connues', () => {
  const blocks = groupByProduct([
    gauge({ product: 'Sans échelle' }),
    gauge({ product: 'Estimé', percent: 40, limitSource: 'derived' }),
    gauge({ product: 'Direct', percent: 10, limitSource: 'live' }),
  ]);
  assert.deepEqual(blocks.map((b) => b.product), ['Direct', 'Estimé', 'Sans échelle']);
});

test('une provenance commune remonte en tête du bloc', () => {
  const [b] = groupByProduct([gauge({ limitSource: 'user' }), gauge({ limitSource: 'user' })]);
  assert.equal(b.origin, originText('user'));
  const [mixed] = groupByProduct([gauge({ limitSource: 'user' }), gauge({ limitSource: 'derived' })]);
  assert.equal(mixed.origin, null);
});

test('une provenance inconnue ne se traduit pas en texte inventé', () => {
  assert.equal(originText('nimporte-quoi'), null);
});

test('une saturation après la réinitialisation ne s\'annonce pas', () => {
  assert.equal(projectionLabel(gauge({ projection: { beforeReset: false, at: Date.now() + 60_000 } })), null);
  assert.notEqual(projectionLabel(gauge({ projection: { beforeReset: true, at: Date.now() + 3_600_000 } })), null);
});
