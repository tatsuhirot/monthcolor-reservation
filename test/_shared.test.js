const { test } = require('node:test');
const assert = require('node:assert');
const { getOccupiedSlotsForItems, serviceForItems } = require('../api/_handlers/_shared');

test('getOccupiedSlotsForItems は menuItems の合計所要時間で枠を返す', () => {
  // 70分(リタッチ)+30分(炭酸泉) = 100分 → 30分刻みで4枠
  const items = [{ durationMin: 70 }, { durationMin: 30 }];
  assert.deepEqual(getOccupiedSlotsForItems('10:00', items), ['10:00','10:30','11:00','11:30']);
});

test('getOccupiedSlotsForItems は空配列なら60分扱いで2枠', () => {
  assert.deepEqual(getOccupiedSlotsForItems('10:00', []), ['10:00','10:30']);
});

test('serviceForItems は最初の有効サービスを主区分にする', () => {
  assert.equal(serviceForItems([{ service: null }, { service: 'hair' }]), 'hair');
  assert.equal(serviceForItems([]), 'hair');
});
