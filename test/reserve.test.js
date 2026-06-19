const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// lib/storage をスタブ（R2に触らない）
let saved = null;
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req.endsWith('storage') || req === '../lib/storage') {
    return { get: async () => [], put: async (_k, body) => { saved = JSON.parse(body); } };
  }
  return origLoad.apply(this, arguments);
};
const handler = require('../api/_handlers/reserve');

function mockRes() {
  return { _c: 200, _j: null, setHeader() {}, status(c){this._c=c;return this;}, json(o){this._j=o;return this;}, end(){return this;} };
}

test('menuItems から service と占有枠を計算して保存する', async () => {
  saved = null;
  const req = { method: 'POST', headers: {}, body: {
    date: '2026-07-02', time: '10:00', name: 'テスト太郎', nameKana: 'てすとたろう',
    phone: '090-0000-0000', source: 'phone',
    menuItems: [{ code: 'T010001', name: '【平日通常】リタッチ', price: 2980, durationMin: 70, service: 'hair' }],
  }};
  const res = mockRes();
  await handler(req, res);
  assert.equal(res._c, 200);
  assert.ok(saved && saved.length === 1);
  assert.equal(saved[0].status, 'pending');
  assert.equal(saved[0].data.visitStatus, 'reserved');
  assert.equal(saved[0].data.service, 'hair');
  assert.equal(saved[0].data.nameKana, 'てすとたろう');
  assert.equal(saved[0].data.menuItems.length, 1);
});

test('必須欠落は400', async () => {
  const res = mockRes();
  await handler({ method: 'POST', headers: {}, body: { time: '10:00', name: 'x' } }, res);
  assert.equal(res._c, 400);
});
