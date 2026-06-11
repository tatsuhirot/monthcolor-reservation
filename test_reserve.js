require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const statePath = path.join(__dirname, '.state/salonboard.json');
const VPS_URL = process.env.VPS_URL;
const SECRET  = process.env.SYNC_TRIGGER_SECRET;

(async () => {
  // VPSにセッションアップロード
  const session = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const res = await fetch(`${VPS_URL}/api/upload-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': SECRET || '' },
    body: JSON.stringify({ session }),
  });
  const json = await res.json();
  console.log('VPS upload:', json.ok ? '✅ 完了' : '❌ ' + json.error);

  // テスト予約をworker.jsで処理（ローカルから直接実行）
  const storage = require('./lib/storage');
  const item = {
    id: 'test-' + Date.now(),
    type: 'register',
    status: 'pending',
    createdAt: new Date().toISOString(),
    data: { date: '2026-09-01', time: '10:00', name: 'テスト太郎', menuName: null }
  };
  const queue = (await storage.get('reservations-queue.json')) || [];
  // 古いテストアイテムを削除
  const clean = queue.filter(q => !q.id.startsWith('test-'));
  clean.push(item);
  await storage.put('reservations-queue.json', JSON.stringify(clean, null, 2));
  console.log('✅ テスト予約追加:', item.id);
  console.log('\nworker.jsを実行します...');
})().catch(e => console.error('❌', e.message));
