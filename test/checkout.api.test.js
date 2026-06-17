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
  if (req === 'resend') return { Resend: class { constructor() { this.emails = { send: async () => {} }; } } };
  return origLoad.apply(this, arguments);
};
process.env.COMINGSOON_PASSWORD = 'pw';
const handler = require('../api/checkout');

function mockRes() {
  return { _c: 200, _j: null, setHeader() {}, status(c){this._c=c;return this;}, json(o){this._j=o;return this;}, end(){return this;} };
}
const AUTH = { authorization: 'Bearer pw' };

function seedReservation() {
  stores = {
    'reservations-queue.json': [{
      id: 'rsv1', status: 'completed',
      data: {
        date: '2026-06-17', time: '12:30', name: '山田 花子', phone: '090-0000-0000',
        menuItems: [{ code: 'T010001', name: 'リタッチ', price: 2980, qty: 1 }],
        visitStatus: 'arrived', staff: '',
      },
    }],
    'sales-log.json': [],
  };
}

test('正常: 予約更新＋sales追記＋伝票No', async () => {
  seedReservation();
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: {
    reservationId: 'rsv1',
    items: [{ code: 'T010001', name: 'リタッチ', price: 2980, qty: 1 }],
    products: [{ id: 'p001', name: 'シャンプー', price: 2200, qty: 1 }],
    discount: { type: 'amount', value: 500 },
    payment: 'cash', tendered: 5000,
  }}, res);
  assert.equal(res._c, 200);
  assert.equal(res._j.slipNo, '20260617-001');
  assert.equal(res._j.total, 4680);
  assert.equal(res._j.change, 320);
  const rsv = stores['reservations-queue.json'][0];
  assert.equal(rsv.data.visitStatus, 'paid');
  assert.equal(rsv.data.checkout.total, 4680);
  assert.equal(rsv.data.checkout.taxIncluded, 425);
  assert.equal(rsv.data.checkout.items.length, 2);
  assert.equal(stores['sales-log.json'].length, 1);
  assert.equal(stores['sales-log.json'][0].slipNo, '20260617-001');
});

test('必須欠落は400', async () => {
  seedReservation();
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: { reservationId: 'rsv1', items: [], products: [], payment: 'cash' } }, res);
  assert.equal(res._c, 400);
});

test('釣り銭マイナスは400', async () => {
  seedReservation();
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: {
    reservationId: 'rsv1', items: [{ name: 'x', price: 5000, qty: 1 }], products: [],
    discount: { type: 'amount', value: 0 }, payment: 'cash', tendered: 1000,
  }}, res);
  assert.equal(res._c, 400);
});

test('予約なしは404', async () => {
  seedReservation();
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: {
    reservationId: 'nope', items: [{ name: 'x', price: 100, qty: 1 }], products: [], payment: 'card',
  }}, res);
  assert.equal(res._c, 404);
});

test('二重会計は409', async () => {
  seedReservation();
  stores['reservations-queue.json'][0].data.visitStatus = 'paid';
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: {
    reservationId: 'rsv1', items: [{ name: 'x', price: 100, qty: 1 }], products: [], payment: 'card',
  }}, res);
  assert.equal(res._c, 409);
});
