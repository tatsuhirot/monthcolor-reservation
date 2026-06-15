const { test } = require('node:test');
const assert = require('node:assert');
const { parseMenuCsv, serviceForCategory, durationForMenu } = require('../lib/menu');

test('serviceForCategory はキーワードで区分を返す', () => {
  assert.equal(serviceForCategory('根元染め(リタッチ)'), 'hair');
  assert.equal(serviceForCategory('セルフホワイトニング'), 'white');
  assert.equal(serviceForCategory('まつ毛パーマ'), 'lash');
  assert.equal(serviceForCategory('ドライヘッドスパ'), 'spa');
  assert.equal(serviceForCategory('割引'), null);
  assert.equal(serviceForCategory('補正'), null);
});

test('durationForMenu は名前の「N分」を優先し、無ければ分類デフォルト', () => {
  assert.equal(durationForMenu('セルフホワイトニング', 'セルフホワイトニング 60分'), 60);
  assert.equal(durationForMenu('根元染め(リタッチ)', '【平日通常】リタッチ'), 70);
  assert.equal(durationForMenu('割引', '【友達紹介】割引'), 0);
});

test('parseMenuCsv はヘッダ行を捨てて service/durationMin 付きの配列を返す', () => {
  const csv = [
    '"技術コード","技術分類","技術名","税込技術料","税抜技術料","基本販売数量","レジ表示"',
    '"T010001","根元染め(リタッチ)","【平日通常】リタッチ","2980","2710","1",""',
    '"W010002","セルフホワイトニング","セルフホワイトニング 60分","6600","6000","1",""',
  ].join('\n');
  const rows = parseMenuCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    code: 'T010001', category: '根元染め(リタッチ)', name: '【平日通常】リタッチ',
    priceIncTax: 2980, priceExTax: 2710, defaultQty: 1, service: 'hair', durationMin: 70,
  });
  assert.equal(rows[1].service, 'white');
  assert.equal(rows[1].durationMin, 60);
});
