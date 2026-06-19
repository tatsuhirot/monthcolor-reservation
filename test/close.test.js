const { test } = require('node:test');
const assert = require('node:assert');
const { DENOMS, DEFAULT_FLOAT, countCash, computeClose } = require('../lib/close');

test('DENOMS は額面の降順10種', () => {
  assert.deepEqual(DENOMS, [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1]);
});

test('DEFAULT_FLOAT は 30000', () => {
  assert.equal(DEFAULT_FLOAT, 30000);
});

test('countCash は Σ(額面×枚数)', () => {
  assert.equal(countCash({ 10000: 4, 1000: 2, 500: 1, 100: 3 }), 42800);
  assert.equal(countCash({}), 0);
  assert.equal(countCash(null), 0);
});

test('countCash は不正値（負/NaN/小数）を0/floor扱い', () => {
  // 10000:-2→0, 5000:'x'→0, 1000:null→0, 500:1.9→floor1×500=500
  assert.equal(countCash({ 10000: -2, 5000: 'x', 1000: null, 500: 1.9 }), 500);
});

test('computeClose: 過不足0（実在高=理論在高）', () => {
  assert.deepEqual(
    computeClose({ float: 30000, cashSales: 12800, denominations: { 10000: 4, 1000: 2, 500: 1, 100: 3 } }),
    { countedCash: 42800, expectedCash: 42800, overShort: 0, deposit: 12800 });
});

test('computeClose: 不足はマイナス', () => {
  const r = computeClose({ float: 30000, cashSales: 12800, denominations: { 10000: 4 } });
  assert.equal(r.countedCash, 40000);
  assert.equal(r.expectedCash, 42800);
  assert.equal(r.overShort, -2800);
  assert.equal(r.deposit, 10000); // 40000 - 30000
});

test('computeClose: 過剰はプラス', () => {
  const r = computeClose({ float: 30000, cashSales: 10000, denominations: { 10000: 5 } });
  assert.equal(r.expectedCash, 40000);
  assert.equal(r.countedCash, 50000);
  assert.equal(r.overShort, 10000);
  assert.equal(r.deposit, 20000);
});

test('computeClose: deposit は負を0クランプ（実在高<準備金）', () => {
  const r = computeClose({ float: 30000, cashSales: 0, denominations: { 10000: 2 } });
  assert.equal(r.deposit, 0); // 20000 - 30000 → 0
});

test('computeClose: float/cashSales の不正値は0扱い', () => {
  const r = computeClose({ float: -5, cashSales: NaN, denominations: { 1000: 1 } });
  assert.equal(r.expectedCash, 0);
  assert.equal(r.countedCash, 1000);
  assert.equal(r.deposit, 1000);
});
