const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

let store = [];
const origLoad = Module._load;
Module._load = function (req) {
  if (req.endsWith('storage') || req === '../lib/storage') {
    return {
      get: async () => store,
      put: async (_k, body) => { store = JSON.parse(body); },
    };
  }
  return origLoad.apply(this, arguments);
};
process.env.COMINGSOON_PASSWORD = 'pw';
const handler = require('../api/products');

function mockRes() {
  return { _c: 200, _j: null, setHeader() {}, status(c){this._c=c;return this;}, json(o){this._j=o;return this;}, end(){return this;} };
}
const AUTH = { authorization: 'Bearer pw' };

test('POST は新規追加し id を採番する', async () => {
  store = [];
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: { name: 'シャンプー', price: 2200 } }, res);
  assert.equal(res._c, 200);
  assert.equal(store.length, 1);
  assert.equal(store[0].name, 'シャンプー');
  assert.equal(store[0].price, 2200);
  assert.equal(store[0].active, true);
  assert.match(store[0].id, /^p\d+$/);
});

test('POST は id 指定で更新する', async () => {
  store = [{ id: 'p001', name: '旧', price: 100, active: true }];
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: { id: 'p001', name: '新', price: 300, active: true } }, res);
  assert.equal(store[0].name, '新');
  assert.equal(store[0].price, 300);
});

test('DELETE は論理削除（active:false）', async () => {
  store = [{ id: 'p001', name: 'x', price: 100, active: true }];
  const res = mockRes();
  await handler({ method: 'DELETE', headers: AUTH, query: { id: 'p001' } }, res);
  assert.equal(store[0].active, false);
});

test('GET ?activeOnly=1 は active のみ返す', async () => {
  store = [
    { id: 'p001', name: 'a', price: 1, active: true },
    { id: 'p002', name: 'b', price: 2, active: false },
  ];
  const res = mockRes();
  await handler({ method: 'GET', headers: AUTH, query: { activeOnly: '1' } }, res);
  assert.equal(res._j.products.length, 1);
  assert.equal(res._j.products[0].id, 'p001');
});

test('認証なしは401', async () => {
  const res = mockRes();
  await handler({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res._c, 401);
});
