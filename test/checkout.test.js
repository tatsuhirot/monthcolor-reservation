const { test } = require('node:test');
const assert = require('node:assert');
const {
  calcSubtotal, applyDiscount, calcTax, calcChange, nextSlipNo, computeCheckout,
} = require('../lib/checkout');

test('calcSubtotal は price×qty の合計', () => {
  assert.equal(calcSubtotal([
    { price: 2980, qty: 1 }, { price: 2200, qty: 1 },
  ]), 5180);
  assert.equal(calcSubtotal([{ price: 1000, qty: 3 }]), 3000);
  assert.equal(calcSubtotal([]), 0);
});

test('applyDiscount amount は min(value, subtotal)', () => {
  assert.deepEqual(applyDiscount(5180, { type: 'amount', value: 500 }),
    { discountAmount: 500, total: 4680 });
  assert.deepEqual(applyDiscount(1000, { type: 'amount', value: 3000 }),
    { discountAmount: 1000, total: 0 }); // 合計超過は0クランプ
});

test('applyDiscount percent は round(subtotal×value/100)', () => {
  assert.deepEqual(applyDiscount(5180, { type: 'percent', value: 10 }),
    { discountAmount: 518, total: 4662 });
  assert.deepEqual(applyDiscount(5180, { type: 'percent', value: 200 }),
    { discountAmount: 5180, total: 0 }); // 100%超も0クランプ
});

test('calcTax は内税10% = round(total - total/1.1)', () => {
  assert.equal(calcTax(4680), 425);
  assert.equal(calcTax(0), 0);
});

test('calcChange は釣り銭、不足は例外', () => {
  assert.equal(calcChange(4680, 5000), 320);
  assert.throws(() => calcChange(4680, 4000), /預かり/);
});

test('nextSlipNo は YYYYMMDD-NNN（当日件数+1, 3桁ゼロ詰め）', () => {
  assert.equal(nextSlipNo('2026-06-17', 0), '20260617-001');
  assert.equal(nextSlipNo('2026-06-17', 12), '20260617-013');
});

test('computeCheckout 物販混在・現金で全項目', () => {
  const r = computeCheckout({
    items: [
      { kind: 'service', price: 2980, qty: 1 },
      { kind: 'product', price: 2200, qty: 1 },
    ],
    discount: { type: 'amount', value: 500 },
    payment: 'cash', tendered: 5000,
  });
  assert.deepEqual(r, { subtotal: 5180, discountAmount: 500, total: 4680, taxIncluded: 425, change: 320 });
});

test('computeCheckout カードは change=null・tendered検証スキップ', () => {
  const r = computeCheckout({
    items: [{ price: 4680, qty: 1 }], discount: { type: 'amount', value: 0 },
    payment: 'card', tendered: null,
  });
  assert.equal(r.change, null);
  assert.equal(r.total, 4680);
});
