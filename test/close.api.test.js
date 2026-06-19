const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

let stores;
const origLoad = Module._load;
Module._load = function (req) {
  if (req.endsWith('storage') || req === '../lib/storage') {
    return {
      get: async (k) => (k in stores ? stores[k] : []),
      put: async (k, body) => { stores[k] = JSON.parse(body); },
    };
  }
  return origLoad.apply(this, arguments);
};
process.env.COMINGSOON_PASSWORD = 'pw';
const handler = require('../api/_handlers/close');

function mockRes() {
  return { _c: 200, _j: null, setHeader() {}, status(c){this._c=c;return this;}, json(o){this._j=o;return this;}, end(){return this;} };
}
const AUTH = { authorization: 'Bearer pw' };

function seed() {
  stores = {
    'sales-log.json': [
      { date: '2026-06-19', payment: 'cash', total: 5000 },
      { date: '2026-06-19', payment: 'cash', total: 7800 },
      { date: '2026-06-19', payment: 'card', total: 8000 },
      { date: '2026-06-18', payment: 'cash', total: 9999 }, // 別日は除外
    ],
    'daily-close.json': [
      { date: '2026-06-15', float: 25000 }, // 過去締め（defaultFloat 復元用）
    ],
  };
}

test('GET: 当日の現金/カード/QR集計と defaultFloat（最新締め）', async () => {
  seed();
  const res = mockRes();
  await handler({ method: 'GET', headers: AUTH, query: { date: '2026-06-19' } }, res);
  assert.equal(res._c, 200);
  assert.equal(res._j.cashSales, 12800);
  assert.equal(res._j.cardSales, 8000);
  assert.equal(res._j.qrSales, 0);
  assert.equal(res._j.defaultFloat, 25000); // 最新締め(6/15)のfloat
  assert.equal(res._j.existing, null);
});

test('GET: 既存締めがあれば existing とその float を返す', async () => {
  seed();
  stores['daily-close.json'].push({ date: '2026-06-19', float: 30000, denominations: { 10000: 1 } });
  const res = mockRes();
  await handler({ method: 'GET', headers: AUTH, query: { date: '2026-06-19' } }, res);
  assert.equal(res._j.defaultFloat, 30000);
  assert.equal(res._j.existing.denominations[10000], 1);
});

test('GET: 締め記録ゼロなら defaultFloat は DEFAULT_FLOAT(30000)', async () => {
  stores = { 'sales-log.json': [], 'daily-close.json': [] };
  const res = mockRes();
  await handler({ method: 'GET', headers: AUTH, query: { date: '2026-06-19' } }, res);
  assert.equal(res._j.defaultFloat, 30000);
});

test('GET: date 無しは400', async () => {
  seed();
  const res = mockRes();
  await handler({ method: 'GET', headers: AUTH, query: {} }, res);
  assert.equal(res._c, 400);
});

test('POST: サーバーで現金売上を再集計し締めを保存', async () => {
  seed();
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: {
    date: '2026-06-19', float: 30000,
    denominations: { 10000: 4, 1000: 2, 500: 1, 100: 3 }, note: 'ok',
  }}, res);
  assert.equal(res._c, 200);
  assert.equal(res._j.cashSales, 12800);     // サーバー再集計（クライアント値は使わない）
  assert.equal(res._j.expectedCash, 42800);
  assert.equal(res._j.countedCash, 42800);
  assert.equal(res._j.overShort, 0);
  assert.equal(res._j.deposit, 12800);
  assert.equal(res._j.cardSales, 8000);
  assert.equal(res._j.note, 'ok');
  const saved = stores['daily-close.json'].find(c => c.date === '2026-06-19');
  assert.ok(saved);
  assert.equal(saved.countedCash, 42800);
});

test('POST: 同日は upsert で置換（重複しない）', async () => {
  seed();
  const before = stores['daily-close.json'].length;
  await handler({ method: 'POST', headers: AUTH, body: { date: '2026-06-19', float: 30000, denominations: { 10000: 4 } } }, mockRes());
  await handler({ method: 'POST', headers: AUTH, body: { date: '2026-06-19', float: 30000, denominations: { 10000: 5 } } }, mockRes());
  const same = stores['daily-close.json'].filter(c => c.date === '2026-06-19');
  assert.equal(same.length, 1);
  assert.equal(same[0].denominations[10000], 5);
  assert.equal(stores['daily-close.json'].length, before + 1);
});

test('POST: denominations 欠落は400', async () => {
  seed();
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: { date: '2026-06-19', float: 30000 } }, res);
  assert.equal(res._c, 400);
});

test('認証なしは401', async () => {
  seed();
  const res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { date: '2026-06-19' } }, res);
  assert.equal(res._c, 401);
});
