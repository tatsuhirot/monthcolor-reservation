const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

let stores;
const origLoad = Module._load;
Module._load = function (req) {
  if (req.endsWith('storage') || req === '../lib/storage') {
    return { get: async (k) => (k in stores ? stores[k] : []), put: async () => {} };
  }
  return origLoad.apply(this, arguments);
};
process.env.COMINGSOON_PASSWORD = 'pw';
const handler = require('../api/sales');

function mockRes() {
  return { _c: 200, _j: null, setHeader() {}, status(c){this._c=c;return this;}, json(o){this._j=o;return this;}, end(){return this;} };
}
const AUTH = { authorization: 'Bearer pw' };

test('totalRevenue は total を使い、旧 finalPrice にフォールバック', async () => {
  stores = {
    'sales-log.json': [
      { date: '2026-06-17', total: 4680, payment: 'cash', items: [{ kind: 'service', name: 'a', price: 2980, qty: 1 }] },
      { date: '2026-06-17', finalPrice: 3000, payment: 'card', menuName: '旧', category: 'hair' },
    ],
    'reservations-queue.json': [],
  };
  const res = mockRes();
  await handler({ method: 'GET', headers: AUTH, query: {} }, res);
  assert.equal(res._j.summary.totalRevenue, 7680);
  assert.equal(res._j.summary.totalCount, 2);
});

test('未会計は queue の visitStatus==="arrived" かつ当日', async () => {
  const today = new Date().toISOString().slice(0, 10);
  stores = {
    'sales-log.json': [],
    'reservations-queue.json': [
      { id: 'a', data: { date: today, visitStatus: 'arrived', name: 'X' } },
      { id: 'b', data: { date: today, visitStatus: 'paid', name: 'Y' } },
      { id: 'c', data: { date: '2000-01-01', visitStatus: 'arrived', name: 'Z' } },
    ],
  };
  const res = mockRes();
  await handler({ method: 'GET', headers: AUTH, query: {} }, res);
  assert.equal(res._j.checkedIn.length, 1);
  assert.equal(res._j.checkedIn[0].id, 'a');
});
