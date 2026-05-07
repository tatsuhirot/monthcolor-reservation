/**
 * api/cron-cs-sync.js
 * Vercel Cron: 毎分 1cs.jp の DWR を直接呼び出して予約データを更新
 *
 * 前提:
 *   sync_comingsoon.js (Playwright) が comingsoon-session.json を Blob に保存済みであること。
 *   GitHub Actions が毎日 09:00 / 13:00 JST に Playwright ログインを実行し、
 *   JSESSIONID と DWR リクエストテンプレートを更新する。
 *
 * vercel.json に以下を追加すること:
 *   { "path": "/api/cron-cs-sync", "schedule": "* * * * *" }
 */

const { head, put } = require('@vercel/blob');

// ── DWR パーサー（sync_comingsoon.js と同じロジック） ────────────────
function parseDwr(dwr) {
  const objMap = {};
  const strRe = /\b(s\d+)\.(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g;
  let m;
  while ((m = strRe.exec(dwr)) !== null) {
    if (!objMap[m[1]]) objMap[m[1]] = {};
    try { objMap[m[1]][m[2]] = JSON.parse('"' + m[3] + '"'); }
    catch { objMap[m[1]][m[2]] = m[3]; }
  }
  const numRe = /\b(s\d+)\.(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g;
  while ((m = numRe.exec(dwr)) !== null) {
    if (!objMap[m[1]]) objMap[m[1]] = {};
    objMap[m[1]][m[2]] = Number(m[3]);
  }
  return objMap;
}

function extractReservations(dwrText) {
  const objMap = parseDwr(dwrText);
  return Object.values(objMap).filter(o => o.customerName && o.reserveTime && o.id);
}

function startTime(reserveTime) {
  const t = (reserveTime || '').split('-')[0].trim();
  if (!t) return '';
  const [h, mm] = t.split(':');
  return `${h.padStart(2, '0')}:${mm || '00'}`;
}

function toDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ── DWR リクエストボディの timestamp と batchId を更新 ───────────────
function refreshDwrBody(originalBody, newBatchId) {
  return originalBody
    .replace(/c0-param1=Date:\d+/, `c0-param1=Date:${Date.now()}`)
    .replace(/batchId=\d+/, `batchId=${newBatchId}`);
}

// ── 1cs.jp に DWR POST を直接送信 ─────────────────────────────────
async function callDwr(jsessionId, reqTemplate, batchId) {
  const body = refreshDwrBody(reqTemplate.body, batchId);
  const resp = await fetch(reqTemplate.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'Cookie': `JSESSIONID=${jsessionId}`,
      'Referer': 'https://1cs.jp/ucs/',
      'Origin': 'https://1cs.jp',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`DWR HTTP ${resp.status}`);
  return resp.text();
}

// ── 今日の日付をセッションに設定（サーバーサイドセッション更新） ────
async function setDateContext(jsessionId, dateKey) {
  try {
    await fetch(`https://1cs.jp/ucs/reserveService.do?StartupDate=${dateKey}`, {
      headers: {
        'Cookie': `JSESSIONID=${jsessionId}`,
        'User-Agent': 'Mozilla/5.0 (compatible)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // ページ取得失敗は無視（セッション有効性はDWR呼び出しで確認）
  }
}

// ── セッションが有効かチェック（DWRレスポンスにデータがあるか） ──────
function isSessionValid(dwrText) {
  // 無効なセッションは空の配列 or エラーメッセージを返す
  if (!dwrText || dwrText.includes('throw') || dwrText.length < 50) return false;
  return true;
}

// ── スタッフ変更通知メール ────────────────────────────────────────
async function notifyStaff(newList, prevList, dateStr) {
  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.STAFF_NOTIFY_EMAIL;
  if (!apiKey || !to) return; // 環境変数未設定時はスキップ

  const prevIds = new Set(prevList.map(r => r.id));
  const newIds  = new Set(newList.map(r => r.id));

  const added   = newList.filter(r => !prevIds.has(r.id));
  const removed = prevList.filter(r => !newIds.has(r.id));

  if (added.length === 0 && removed.length === 0) return;

  const row = r => `<tr>
    <td style="padding:4px 10px;border-bottom:1px solid #eee">${r.time}</td>
    <td style="padding:4px 10px;border-bottom:1px solid #eee">${r.name}</td>
    <td style="padding:4px 10px;border-bottom:1px solid #eee">${r.menu}</td>
    <td style="padding:4px 10px;border-bottom:1px solid #eee">${r.phone || '—'}</td>
  </tr>`;
  const thead = `<tr style="background:#f5f5f5"><th style="padding:4px 10px">時間</th><th>お名前</th><th>メニュー</th><th>電話</th></tr>`;

  let html = `<p style="font-family:sans-serif;font-size:14px"><strong>${dateStr}</strong> の予約に変更がありました。</p>`;
  if (added.length > 0) {
    html += `<h3 style="color:#2d6a31;font-family:sans-serif">✅ 新規予約 ${added.length}件</h3>
    <table style="border-collapse:collapse;font-size:13px;font-family:sans-serif">${thead}${added.map(row).join('')}</table>`;
  }
  if (removed.length > 0) {
    html += `<h3 style="color:#c00;font-family:sans-serif">❌ キャンセル ${removed.length}件</h3>
    <table style="border-collapse:collapse;font-size:13px;font-family:sans-serif">${thead}${removed.map(row).join('')}</table>`;
  }

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'onboarding@resend.dev',
      to,
      subject: `[MONTH COLOR] ${dateStr} 予約変更通知（${added.length > 0 ? `+${added.length}` : ''}${removed.length > 0 ? ` -${removed.length}` : ''}）`,
      html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

module.exports = async function handler(req, res) {
  // Vercel Cron 認証（CRON_SECRET は Vercel が自動注入）
  const authHeader = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const today = new Date();
  // JST (UTC+9) に補正
  today.setTime(today.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = toDateStr(today);
  const dateKey = dateStr.replace(/-/g, '');

  try {
    // ── セッションデータを Blob から読み込み ─────────────────────────
    const sessionMeta = await head('comingsoon-session.json', {
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    if (!sessionMeta) {
      return res.status(200).json({ ok: false, reason: 'no session — run sync_comingsoon.js first' });
    }
    const session = await fetch(sessionMeta.url).then(r => r.json());

    const { jsessionId, dwrRequests } = session;
    if (!jsessionId || !dwrRequests?.length) {
      return res.status(200).json({ ok: false, reason: 'session data incomplete' });
    }

    // セッション保存から24時間以上経過していたら警告
    const sessionAge = Date.now() - new Date(session.savedAt).getTime();
    if (sessionAge > 24 * 60 * 60 * 1000) {
      console.warn(`⚠️ セッションが古い: ${Math.floor(sessionAge / 3600000)}時間前`);
    }

    // ── 日付コンテキストをサーバーセッションに設定 ──────────────────
    await setDateContext(jsessionId, dateKey);

    // ── 全 DWR テンプレートを順次実行（batchId を 1 から連番） ─────
    // 並列ではなく順次: batchId の順序が意味を持つ可能性があるため
    const dwrTexts = await Promise.allSettled(
      dwrRequests.map((tmpl, i) => callDwr(jsessionId, tmpl, i + 1))
    );

    const validTexts = dwrTexts
      .filter(r => r.status === 'fulfilled' && isSessionValid(r.value))
      .map(r => r.value);

    if (validTexts.length === 0) {
      return res.status(200).json({
        ok: false,
        reason: 'DWR calls returned no valid data (session may be expired)',
        date: dateStr,
      });
    }

    // ── 予約データをパース・重複排除 ────────────────────────────────
    const allReservations = [];
    const seenIds = new Set();
    for (const text of validTexts) {
      for (const item of extractReservations(text)) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allReservations.push({
            id:         item.id,
            time:       startTime(item.reserveTime),
            timeRange:  item.reserveTime,
            name:       item.customerName || '不明',
            nameKana:   item.customerNameKana || '',
            menu:       item.name || '',
            phone:      item.customerPhoneNo2 || item.customerPhoneNo || '',
            email:      item.customerMailAddress || '',
            visitCount: item.customerReservationCount || 0,
            note:       item.userComment || '',
            source:     'comingsoon',
          });
        }
      }
    }
    allReservations.sort((a, b) => a.time.localeCompare(b.time));

    // ── 既存データと比較して変化があれば保存 ────────────────────────
    let changed = true;
    let prevReservations = [];
    const existingMeta = await head(`comingsoon-${dateStr}.json`, {
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    if (existingMeta) {
      const existing = await fetch(existingMeta.url).then(r => r.json());
      prevReservations = existing.reservations || [];
      if (JSON.stringify(prevReservations) === JSON.stringify(allReservations)) {
        changed = false;
      }
    }

    if (changed) {
      const payload = JSON.stringify({
        updatedAt: new Date().toISOString(),
        date: dateStr,
        reservations: allReservations,
      }, null, 2);

      await Promise.all([
        put(`comingsoon-${dateStr}.json`, payload, {
          access: 'public', addRandomSuffix: false, allowOverwrite: true,
          token: process.env.BLOB_READ_WRITE_TOKEN,
        }),
        put('comingsoon-today.json', payload, {
          access: 'public', addRandomSuffix: false, allowOverwrite: true,
          token: process.env.BLOB_READ_WRITE_TOKEN,
        }),
      ]);
    }

    // ── 変更があればスタッフ通知 ──────────────────────────────────
    if (changed) {
      notifyStaff(allReservations, prevReservations, dateStr).catch(e =>
        console.error('notify error:', e.message)
      );
    }

    return res.status(200).json({
      ok: true,
      changed,
      count: allReservations.length,
      templates: dwrRequests.length,
      validResponses: validTexts.length,
      date: dateStr,
    });

  } catch (e) {
    console.error('cron-cs-sync error:', e.message);
    return res.status(500).json({ ok: false, error: e.message, date: dateStr });
  }
};
