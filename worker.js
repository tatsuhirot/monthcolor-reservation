/**
 * worker.js — ローカル予約処理ワーカー
 *
 * Vercel Blob の予約キューを取得し、
 * pending な予約を Playwright で SalonBoard に登録する。
 *
 * 使い方:
 *   node worker.js          # 未処理の予約を全件処理して終了
 *   node worker.js --watch  # 60秒ごとにポーリング（常時起動）
 *
 * VPS 移行時はこのファイルをそのままサーバーに置いて
 *   node worker.js --watch
 * で動かすだけでOK。
 */

require('dotenv').config();
const storage = require('./lib/storage');
const { firefox } = require('playwright');
const { launchHumanBrowser, humanClick, humanType, randomDelay } = require('./lib/human-browser');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const tmpDir = os.tmpdir();

const QUEUE_KEY         = 'reservations-queue.json';
const POLL_INTERVAL     = 60_000;        // 60秒ごとにキュー確認
const SLOTS_SYNC_INTERVAL = 60 * 60_000; // 1時間ごとに空き枠同期
const stateDir  = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'salonboard.json');
const lockPath  = path.join(stateDir, 'playwright.lock'); // Playwright 排他ロック
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
// 起動時に残留lockを削除（PM2再起動後のstale lock対策）
if (fs.existsSync(lockPath)) {
  fs.unlinkSync(lockPath);
  console.log('🧹 起動時に残留lockを削除しました');
}

async function deleteStorageState() {
  try {
    await fs.promises.rm(statePath, { force: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

const isWatch = process.argv.includes('--watch');
const isRetry = process.argv.includes('--retry');

let lastSlotsSync = 0; // 最後に空き枠同期した時刻
let _isBusy = false;  // 予約処理中フラグ

// ── メイン ───────────────────────────────────────────────────────
async function main() {
  if (isRetry) {
    console.log('🔁 リトライモード: failed な予約を再処理します\n');
    await retryFailed();
  } else if (isWatch) {
    console.log(`🔄 ウォッチモード: ${POLL_INTERVAL / 1000}秒ごとにキューを確認 / 1時間ごとに空き枠同期`);
    console.log('   終了するには Ctrl+C\n');
    while (true) {
      await processQueue();
      await syncSlotsIfNeeded();
      await sleep(POLL_INTERVAL);
    }
  } else {
    await processQueue();
  }
}

// ── 空き枠同期（1時間ごと、Playwright ロックで排他制御） ───────────────
async function syncSlotsIfNeeded() {
  const elapsed = Date.now() - lastSlotsSync;
  if (elapsed < SLOTS_SYNC_INTERVAL) return; // まだ時間になっていない
  await runSyncSlots();
}

// ── 空き枠同期の実体（強制実行用。ロックチェックのみ） ───────────────────
async function runSyncSlots() {
  if (_isBusy) {
    console.log('   ⏸  予約処理中のためスロット同期をスキップ');
    return;
  }

  if (fs.existsSync(lockPath)) {
    console.log(`[${now()}] ⏭ 空き枠同期スキップ（Playwright ロック中）`);
    return;
  }

  console.log(`[${now()}] 🗓 空き枠同期を開始します...`);
  const result = spawnSync('node', ['sync_slots.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    timeout: 20 * 60_000,
  });
  if (result.status === 0) {
    lastSlotsSync = Date.now();
    console.log(`[${now()}] ✅ 空き枠同期完了`);
  } else {
    console.error(`[${now()}] ❌ 空き枠同期失敗 (exit: ${result.status})、15分後に再試行`);
    lastSlotsSync = Date.now() - SLOTS_SYNC_INTERVAL + (15 * 60_000); // 15分後に再試行
  }
}

// キャンセル日が今日から3日以内か判定
function isWithin3Days(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  const diffDays = Math.floor((target - today) / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays <= 2; // 当日(0)・翌日(1)・翌々日(2)
}

// ── リトライ処理 ──────────────────────────────────────────────────
async function retryFailed() {
  const queue = await loadQueue();
  const failed = queue.filter(r => r.status === 'failed');

  if (failed.length === 0) {
    console.log(`[${now()}] ✅ 失敗した予約はありません`);
    return;
  }

  console.log(`[${now()}] 🔁 失敗した予約: ${failed.length}件 → pending に戻して再処理します\n`);

  for (const r of failed) {
    r.status = 'pending';
    r.error  = null;
    r.retriedAt = new Date().toISOString();
  }
  await saveQueue(queue);
  await processQueue();
}

// ── キュー処理 ────────────────────────────────────────────────────
async function processQueue() {
  const queue = await loadQueue();
  const pending = queue.filter(r => r.status === 'pending');

  if (pending.length === 0) {
    console.log(`[${now()}] ✅ 未処理の予約はありません`);
    return;
  }

  console.log(`[${now()}] 📋 未処理の予約: ${pending.length}件`);

  for (const reservation of pending) {
    const { id, type = 'register', data } = reservation;
    console.log(`\n[${now()}] ⏳ 処理中 [${type}]: ${id} / ${data.date} ${data.time} / ${data.name}`);

    // ステータスを processing に更新（二重処理防止）
    await updateStatus(queue, id, 'processing');

    try {
      if (type === 'register') {
        _isBusy = true;
        try {
          await registerInSalonBoard(data);
        } finally {
          _isBusy = false;
        }
      } else if (type === 'cancel') {
        await cancelInSalonBoard(data);
        // 直近3日以内のキャンセルは即時sync（当日は特に重要）
        if (isWithin3Days(data.date)) {
          console.log(`[${now()}] 📅 直近3日以内のキャンセル（${data.date}）→ 即時sync実行`);
          await runSyncSlots();
        }
      }
      await updateStatus(queue, id, 'completed');
      console.log(`[${now()}] ✅ 完了 [${type}]: ${id}`);
    } catch (err) {
      console.error(`[${now()}] ❌ 失敗 [${type}]: ${id} — ${err.message}`);
      await updateStatus(queue, id, 'failed', err.message);
    }
  }
}

// ── goto リトライヘルパー ─────────────────────────────────────────
// Akamaiの間欠スロットリングでタイムアウトすることがあるため、
// 待機時間を延ばしながら最大 retries 回リトライする
async function gotoWithRetry(page, url, { retries = 3, waitMs = 30_000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      const delay = waitMs * (i + 1); // 30s → 60s → 90s
      console.log(`   ⏳ goto失敗(${i + 1}/${retries}): ${e.message.split('\n')[0]} → ${delay / 1000}秒後にリトライ`);
      await sleep(delay);
    }
  }
}

// ── SalonBoard ログイン共通ヘルパー ──────────────────────────────────
// ※ VPSからlogin_spを踏むとAkamaiにブロックされるため、
//    スケジュールページに直接アクセスしてセッション確認する
async function ensureLoggedIn(page, context, dateKey) {
  try {
    console.log('   🔐 SalonBoard スケジュールページにアクセス中...');
    const url = `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`;
    await gotoWithRetry(page, url);

    // セッション切れの判定:
    //  ① /login へリダイレクトされるケース
    //  ② リダイレクトされず同URLで「SALON BOARD : エラー」ページが返るケース
    //     （本文: 「一定時間操作されなかったため、ログインの有効期限が切れました。」）
    //  URLしか見ないとエラーページを「有効」と誤判定し、後続で
    //  「空き枠が見つかりません」等の紛らわしいエラーになるため、内容も検査する。
    const expired = await page.evaluate(() => {
      const title = document.title || '';
      const body = document.body ? document.body.innerText : '';
      return title.includes('エラー') ||
        body.includes('ログインの有効期限が切れ') ||
        body.includes('再度ログインしなおして');
    }).catch(() => false);

    if (page.url().includes('/login') || expired) {
      // セッション切れ → VPSからはログイン不可なのでエラーにする
      await page.screenshot({ path: path.join(tmpDir, 'salonboard-session-expired.png'), fullPage: true }).catch(() => null);
      throw new Error(
        'SalonBoardのセッションが切れています。\n' +
        'ローカルPCで「node update-session.js」を実行してセッションを更新してください。'
      );
    }

    console.log('   ✅ セッション有効 →', page.url());
  } catch (err) {
    if (err.message.includes('セッションが切れています')) {
      await deleteStorageState();
    }
    throw err;
  }
}

// ── SalonBoard 登録（server.js から移植）──────────────────────────
async function registerInSalonBoard({ date, time, name, menuName, nameKana }) {
  const { browser, context, page } = await launchHumanBrowser(statePath);

  try {
    const dateKey = date.replace(/-/g, '');
    // ensureLoggedIn が目的の日付ページまで遷移済みなので再gotoは不要
    await ensureLoggedIn(page, context, dateKey);
    await page.waitForTimeout(2000);

    const timeKey = time.replace(':', '');
    // スタイリストIDを限定せず、その時間帯に空いている誰でも選ぶ（6枠対応）
    const targetId = await page.evaluate(({ dateKey, timeKey }) => {
      const el = document.querySelector(`[id^="empty_time_sid_fix_${dateKey}_${timeKey}_"]`);
      return el ? el.id.replace('empty_time_sid_fix_', '') : null;
    }, { dateKey, timeKey });
    if (!targetId) throw new Error(`空き枠が見つかりません（${date} ${time}）`);

    // 登録フォームへGET直アクセス（クリックハンドラの遷移先と同じ）
    const stylistId = targetId.split('_')[2];
    console.log(`   📌 空き枠: ${targetId} → 登録フォームへ遷移`);
    await gotoWithRetry(
      page,
      `https://salonboard.com/CLP/bt/reserve/ext/extReserveRegist/?date=${dateKey}&time=${timeKey}&stylistId=${stylistId}`
    );
    await page.waitForTimeout(2000);
    if (!page.url().includes('extReserveRegist')) {
      throw new Error(`登録フォームに遷移できませんでした → ${page.url()}`);
    }

    try {
      await fillForm(page, { name, menuName, nameKana });
    } catch (err) {
      // 登録POSTがAkamaiにリセットされても、POST自体はサーバーに届いて
      // 登録済みのことがある（2026-06-12実証: ERR_CONNECTION_RESETでも
      // スケジュールページに「テスト タロウ 様」が登録されていた）。
      // 失敗扱いにする前にスケジュールページで実登録を確認する
      if (!err.message.includes('登録が完了しませんでした')) throw err;
      console.log('   🔍 完了画面に到達できず → スケジュールページで実登録を確認中...');
      const registered = await verifyRegistered(page, { dateKey, name });
      if (!registered) throw err;
      console.log('   ✅ スケジュールページで登録を確認 → 成功扱い');
    }
    await context.storageState({ path: statePath });

  } catch (err) {
    // セッション切れの場合のみstorageStateを削除（その他のエラーで消すと
    // 手動取得したCookieが失われ復旧が大変になる）
    if (err.message.includes('セッションが切れています')) {
      await deleteStorageState();
    }
    throw err;
  } finally {
    await browser.close();
  }
}

// メニュー一覧（#menuIdList / setmenuId）から部分一致で選択
async function trySelectMenu(page, menuName) {
  return page.evaluate((mn) => {
    const sels = [document.querySelector('#menuIdList'), document.querySelector('select[name="setmenuId"]')];
    for (const sel of sels) {
      if (!sel) continue;
      for (const opt of sel.options) {
        if (opt.textContent.includes(mn)) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return opt.textContent.trim();
        }
      }
    }
    return null;
  }, menuName);
}

// 完了画面に到達できなかった場合の実登録確認
// （スケジュールページに「姓 名 様」が表示されているかで判定）
async function verifyRegistered(page, { dateKey, name }) {
  try {
    await gotoWithRetry(page, `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`);
    const parts = (name || '').trim().split(/[\s　]+/).filter(Boolean);
    return await page.evaluate((parts) => {
      const lines = (document.body.innerText || '').split('\n');
      return lines.some(l => parts.every(p => l.includes(p)));
    }, parts);
  } catch {
    return false; // 確認自体に失敗した場合は従来どおり失敗扱い
  }
}

// ひらがな→カタカナ変換
function toKatakana(str) {
  return str.replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

// 予約新規登録フォーム（/CLP/bt/reserve/ext/extReserveRegist/）への入力
async function fillForm(page, { name, menuName, nameKana }) {
  // 氏名を「姓 名」に分割（スペースがなければ姓のみ）
  const parts = (name || '').trim().split(/[\s　]+/);
  const sei = parts[0] || '';
  const mei = parts.slice(1).join(' ') || '';

  // カナ（必須）: nameKana優先 / なければnameをカタカナ変換して使用
  const kanaParts = (nameKana ? nameKana.trim() : toKatakana(name || '')).split(/[\s　]+/);
  const seiKana = kanaParts[0] || '';
  const meiKana = kanaParts.slice(1).join('') || '';

  await page.fill('#nmSeiKana', seiKana);
  if (meiKana) await page.fill('#nmMeiKana', meiKana);
  await page.fill('#nmSei', sei);
  if (mei) await page.fill('#nmMei', mei);
  console.log(`   ✏️  氏名: ${sei} ${mei} (${seiKana} ${meiKana})`);

  if (menuName) {
    // まずメニュー一覧から直接選択を試みる
    let selected = await trySelectMenu(page, menuName);
    // 見つからない場合はメニューカテゴリ（例:「ヘア カラー」）を順に選択して再探索
    // （カテゴリ選択後にメニュー一覧が動的に絞り込まれるため、未選択だと空のことがある）
    if (!selected) {
      const catValues = await page.evaluate(() => {
        const sel = document.querySelector('select[id*="ategory"], select[name*="ategory"]');
        return sel ? [...sel.options].map(o => o.value).filter(Boolean) : [];
      });
      for (const v of catValues) {
        await page.evaluate((v) => {
          const sel = document.querySelector('select[id*="ategory"], select[name*="ategory"]');
          sel.value = v;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, v);
        await page.waitForTimeout(800);
        selected = await trySelectMenu(page, menuName);
        if (selected) break;
      }
    }
    if (selected) console.log(`   ✏️  メニュー: ${selected}`);
    else console.log(`   ⚠️  メニュー「${menuName}」が見つからずスキップ`);
  }

  // 登録ボタン #regist → ネイティブconfirm「予約を登録します。よろしいですか？」を自動承諾
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.locator('#regist').click({ noWaitAfter: true });
  console.log('   📨 登録ボタンをクリック');

  // doComplete遷移 or 警告モーダル（受付可能数超過など）を最大60秒監視
  let done = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const url = page.url();
    // HTML警告モーダルが出たらOKで続行
    const okBtn = page.locator('.mod_popup a:has-text("OK"), a:has-text("OK"), input[value="OK"]').first();
    const okVisible = await okBtn.isVisible().catch(() => false);
    if (okVisible) {
      console.log('   ⚠️  警告モーダル → OK で続行');
      await okBtn.click({ noWaitAfter: true }).catch(() => {});
      await page.waitForTimeout(3000);
      continue;
    }
    if (url.includes('doComplete')) { done = true; break; }
    if (url.startsWith('chrome-error')) break; // 接続リセット
  }

  if (!done) {
    const errs = await page.$$eval('.error, .err, [class*="error"]', els =>
      els.map(e => e.textContent.trim()).filter(Boolean).slice(0, 5)
    ).catch(() => []);
    await page.screenshot({ path: path.join(tmpDir, 'salonboard-register-error.png'), fullPage: true }).catch(() => null);
    throw new Error(`登録が完了しませんでした（URL: ${page.url()}）${errs.length ? ' エラー: ' + errs.join(' / ') : ''}`);
  }
  console.log(`   ✅ 登録完了 → ${page.url()}`);
}

// ── SalonBoard キャンセル ─────────────────────────────────────────
async function cancelInSalonBoard({ date, time, name }) {
  const { browser, context, page } = await launchHumanBrowser(statePath);

  try {
    const dateKey = date.replace(/-/g, '');
    await ensureLoggedIn(page, context, dateKey);

    // スケジュールページで該当予約ブロックを探す
    await page.goto(
      `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${dateKey}`,
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(1500);

    const timeKey = time.replace(':', '');
    const stylistId = await resolveStaffId(page);

    // SalonBoard の予約済みセルは reserve_sid_fix_{date}_{time}_{staffId} 形式
    // （empty_time_sid_fix_ の逆パターン — 調査済み）
    const reserveBlock = await page.$(
      `[id^="reserve_sid_fix_${dateKey}_${timeKey}_${stylistId}"]` +
      `, [id^="reserve_sid_fix_${dateKey}_${timeKey}_"]`  // stylistId が変わっていても拾う
    );

    if (!reserveBlock) {
      // 全予約ブロックをダンプしてデバッグログ
      const allReserveIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[id^="reserve_sid_fix_"]')).map(el => el.id)
      );
      console.error(`   ⚠️ 予約ブロック一覧: ${JSON.stringify(allReserveIds)}`);
      throw new Error(
        `キャンセル対象の予約ブロックが見つかりません（${date} ${time} / ${name}）。` +
        `手動でSalonBoardを確認してください。`
      );
    }

    await reserveBlock.click();
    await page.waitForTimeout(1500);

    // 詳細ページ or ポップアップでキャンセルボタンを押す
    const cancelBtn = await page.$(
      'a:has-text("キャンセル"), button:has-text("キャンセル"), ' +
      'a:has-text("削除"), button:has-text("削除"), ' +
      'input[value*="キャンセル"], input[value*="削除"]'
    );
    if (!cancelBtn) throw new Error('キャンセルボタンが見つかりません。手動で操作してください。');

    await cancelBtn.click();
    await page.waitForTimeout(1000);

    // 確認ダイアログがある場合
    const confirmBtn = await page.$(
      'button:has-text("OK"), button:has-text("はい"), input[value="OK"], input[value="はい"]'
    );
    if (confirmBtn) await confirmBtn.click();

    await page.waitForTimeout(1000);
    await context.storageState({ path: statePath });
    console.log(`   ✅ SalonBoard キャンセル完了: ${date} ${time} / ${name}`);

  } catch (err) {
    await deleteStorageState();
    throw err;
  } finally {
    await browser.close();
  }
}

async function resolveStaffId(page) {
  const firstSlotId = await page.evaluate(() => {
    const el = document.querySelector('[id^="empty_time_sid_fix_"]');
    return el ? el.id : null;
  });
  if (firstSlotId) {
    const parts = firstSlotId.split('_');
    const idx = parts.findIndex(p => p.startsWith('T') && p.length > 5);
    if (idx !== -1) return parts[idx];
  }
  return 'T000779306';
}

// ── ストレージ キュー操作 ─────────────────────────────────────────
async function loadQueue() {
  try {
    return (await storage.get(QUEUE_KEY)) || [];
  } catch {
    return [];
  }
}

async function updateStatus(queue, id, status, error = null) {
  const item = queue.find(r => r.id === id);
  if (!item) return;
  item.status      = status;
  item.processedAt = new Date().toISOString();
  item.error       = error;
  await saveQueue(queue);
}

async function saveQueue(queue) {
  await storage.put(QUEUE_KEY, JSON.stringify(queue, null, 2));
}

// ── ユーティリティ ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleTimeString('ja-JP'); }

main().catch(err => {
  console.error('❌ ワーカーエラー:', err.message);
  process.exit(1);
});
