const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

let store;
const origLoad = Module._load;
Module._load = function (req) {
  if (req.endsWith('storage') || req === '../lib/storage') {
    return { get: async () => store, put: async (_k, body) => { store = JSON.parse(body); } };
  }
  return origLoad.apply(this, arguments);
};
process.env.COMINGSOON_PASSWORD = 'pw';
const handler = require('../api/admin-action');

function mockRes() {
  return { _c: 200, _j: null, setHeader() {}, status(c){this._c=c;return this;}, json(o){this._j=o;return this;}, end(){return this;} };
}
const AUTH = { authorization: 'Bearer pw' };

test('setVisitStatus は data.visitStatus を更新する', async () => {
  store = [{ id: 'r1', status: 'completed', data: { visitStatus: 'reserved' } }];
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: { action: 'setVisitStatus', id: 'r1', visitStatus: 'arrived' } }, res);
  assert.equal(res._c, 200);
  assert.equal(store[0].data.visitStatus, 'arrived');
});

test('setVisitStatus 不正値は400', async () => {
  store = [{ id: 'r1', status: 'completed', data: { visitStatus: 'reserved' } }];
  const res = mockRes();
  await handler({ method: 'POST', headers: AUTH, body: { action: 'setVisitStatus', id: 'r1', visitStatus: 'bogus' } }, res);
  assert.equal(res._c, 400);
});
