/**
 * api/cron-sync-slots.js — Vercel Cron で SalonBoard 空き枠を自動同期
 *
 * Vercel Cron: GET /api/cron-sync-slots (vercel.json で schedule 設定)
 * 手動実行:   POST /api/cron-sync-slots  Authorization: Bearer <ADMIN_PASSWORD>
 *
 * Playwright ではなく plain fetch で SalonBoard にログイン→スクレイピング。
 * ブラウザ不要なので Vercel サーバーレス環境で完全動作する。
 */

const { put } = require('@vercel/blob');

/* ── Cookie jar ──────────────────────────────────────────────── */

function mergeSetCookies(jar, response) {
  // Node 18+ では getSetCookie() で複数の Set-Cookie ヘッダーを配列取得
  let cookies = [];
  if (typeof response.headers.getSetCookie === 'function') {
    cookies = response.headers.getSetCookie();
  } else {
    const raw = response.headers.get('set-cookie');
    if (raw) cookies = [raw];
  }
  for (const c of cookies) {
    const [nameVal] = c.split(';');
    const eqIdx = nameVal.indexOf('=');
    if (eqIdx === -1) continue;
    const k = nameVal.slice(0, eqIdx).trim();
    const v = nameVal.slice(eqIdx + 1).trim();
    if (k) jar[k] = v;
  }
}

function cookieStr(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/* ── HTML パーサー (sync_slots.js と同一ロジック) ─────────────── */

function parseEmptySlots(html) {
  const re = /id="empty_time_sid_fix_(\d{8})_(\d{4})_(T\d+)_(\d+)"/g;
  const seen = new Set();
  const byDate = {};
  let m;
  while ((m = re.exec(html)) !== null) {
    const key = `${m[1]}_${m[2]}_${m[3]}_${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const date = `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`;
    const time = `${m[2].slice(0,2)}:${m[2].slice(2,4)}`;
    if (!byDate[date]) byDate[date] = new Set();
    byDate[date].add(time);
  }
  const result = {};
  for (const [date, times] of Object.entries(byDate)) {
    result[date] = [...times].sort();
  }
  return result;
}

/* ── メインハンドラー ─────────────────────────────────────────── */

module.exports = async function handler(req, res) {
  // Vercel Cron は GET。手動テストは Authorization ヘッダー付きで GET/POST
  const auth = (req.headers.authorization ?? '').replace('Bearer ', '');
  const isCron = req.headers['x-vercel-cron'] === '1';
  if (!isCron && auth !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized — ?Authorization: Bearer ADMIN_PASSWORD が必要です' });
  }

  const jar = {};
  const UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0';

  const baseHeaders = (extra = {}) => ({
    'User-Agent':      UA,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
    'Connection':      'keep-alive',
    'Cookie':          cookieStr(jar),
    ...extra,
  });

  try {
    // ── 疎通確認 ──────────────────────────────────────────────────
    const pingRes = await fetch('https://salonboard.com/', {
      headers: baseHeaders(), redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    }).catch(e => ({ ok: false, _err: e.message }));
    if (!pingRes.ok) {
      console.error('[sync-slots] Ping failed:', pingRes._err ?? pingRes.status);
      return res.status(500).json({ error: 'Cannot reach SalonBoard', detail: pingRes._err ?? pingRes.status });
    }

    // ── 1. ログインページ取得（初期 Cookie） ─────────────────────
    const loginPageRes = await fetch('https://salonboard.com/login/', {
      headers: baseHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    mergeSetCookies(jar, loginPageRes);

    // ── 2. ログイン POST ─────────────────────────────────────────
    const formBody = new URLSearchParams({
      userId:   process.env.SALONBOARD_LOGIN_ID   ?? '',
      password: process.env.SALONBOARD_PASSWORD   ?? '',
    });

    const loginRes = await fetch('https://salonboard.com/CNC/login/doLogin/', {
      method:   'POST',
      headers:  baseHeaders({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer':      'https://salonboard.com/login/',
        'Origin':       'https://salonboard.com',
      }),
      body:     formBody.toString(),
      redirect: 'manual',
    });
    mergeSetCookies(jar, loginRes);

    const location = loginRes.headers.get('location') ?? '';
    const loginOk  = loginRes.status === 302 && location && !location.includes('/login/');
    if (!loginOk) {
      console.error('[sync-slots] Login failed. status:', loginRes.status, 'location:', location);
      return res.status(500).json({ error: 'SalonBoard login failed', status: loginRes.status, location });
    }

    // リダイレクト先へ遷移してセッションを確定
    const absLocation = location.startsWith('http') ? location : `https://salonboard.com${location}`;
    const afterRes = await fetch(absLocation, { headers: baseHeaders(), redirect: 'follow' });
    mergeSetCookies(jar, afterRes);
    console.log('[sync-slots] Login OK →', absLocation);

    // ── 3. カレンダーページをスクレイピング（今月・来月） ────────
    const allSlots = {};
    const now = new Date();

    for (let i = 0; i < 2; i++) {
      const d       = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const dateKey = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
      const label   = `${d.getFullYear()}年${d.getMonth() + 1}月`;

      const calRes = await fetch(
        `https://salonboard.com/CLP/bt/schedule/salonSchedule/?pv_date=${dateKey}`,
        { headers: baseHeaders(), redirect: 'follow' }
      );
      mergeSetCookies(jar, calRes);

      if (!calRes.ok) {
        console.warn(`[sync-slots] ${label} fetch failed: ${calRes.status}`);
        continue;
      }

      const html  = await calRes.text();
      const slots = parseEmptySlots(html);
      Object.assign(allSlots, slots);

      const days  = Object.keys(slots).length;
      const count = Object.values(slots).reduce((s, a) => s + a.length, 0);
      console.log(`[sync-slots] ${label}: ${days}日 / ${count}枠`);
    }

    // ── 4. Vercel Blob に保存 ────────────────────────────────────
    const payload = JSON.stringify({ updatedAt: new Date().toISOString(), slots: allSlots }, null, 2);
    await put('slots-data.json', payload, {
      access:          'public',
      addRandomSuffix: false,
      token:           process.env.BLOB_READ_WRITE_TOKEN,
    });

    const totalDays  = Object.keys(allSlots).length;
    const totalSlots = Object.values(allSlots).reduce((s, a) => s + a.length, 0);

    console.log(`[sync-slots] ✅ 完了: ${totalDays}日分 / ${totalSlots}枠`);
    return res.status(200).json({
      ok:        true,
      updatedAt: new Date().toISOString(),
      stats:     { days: totalDays, slots: totalSlots },
    });

  } catch (err) {
    console.error('[sync-slots] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
