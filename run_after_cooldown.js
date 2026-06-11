/**
 * run_after_cooldown.js — Akamaiスロットリング解除を待ってから予約テストを実行
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const storage = require('./lib/storage');

(async () => {
  console.log('20分クールダウン中...（Akamaiスロットリング解除待ち）');
  await new Promise(r => setTimeout(r, 20 * 60 * 1000));

  // Cookie復元 & キューをpendingに
  fs.copyFileSync('memo.txt', '.state/salonboard.json');
  const queue = await storage.get('reservations-queue.json');
  const item = queue.find(r => r.id.startsWith('test-'));
  item.status = 'pending';
  item.error = null;
  await storage.put('reservations-queue.json', JSON.stringify(queue, null, 2));
  console.log('✅ Cookie復元 & キューを pending に戻しました → worker.js 実行\n');

  const result = spawnSync('node', ['worker.js'], { cwd: __dirname, stdio: 'inherit', timeout: 15 * 60 * 1000 });
  process.exit(result.status ?? 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
