/**
 * api/cron.js
 * (cron-cs-sync.js + cron-remind.js + cron-morning-report.js を統合)
 *
 * GET /api/cron?type=cs-sync        → coming-soon DWR 同期（旧 cron-cs-sync）
 * GET /api/cron?type=remind         → 前日リマインダーメール（旧 cron-remind）
 * GET /api/cron?type=morning-report → LINE Notify 朝の日報（旧 cron-morning-report）
 *
 * vercel.json crons:
 *   { "path": "/api/cron?type=cs-sync",        "schedule": "0 0 * * *" }
 *   { "path": "/api/cron?type=remind",          "schedule": "0 10 * * *" }
 *   { "path": "/api/cron?type=morning-report",  "schedule": "0 23 * * *" }
 */

require('dotenv').config();
const storage = require('../../lib/storage');

// ═══════════════════════════════════════════════════════════════
// 共通ユーティリティ
// ═══════════════════════════════════════════════════════════════

function toDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function todayJST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return toDateStr({ getFullYear: () => now.getUTCFullYear(), getMonth: () => now.getUTCMonth(), getDate: () => now.getUTCDate() });
}

function authCron(req) {
  const authHeader = req.headers['authorization'] || '';
  return !process.env.CRON_SECRET || authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

// ═══════════════════════════════════════════════════════════════
// CS-SYNC: coming-soon DWR 直接呼び出し
// ═══════════════════════════════════════════════════════════════

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

function refreshDwrBody(originalBody, newBatchId) {
  return originalBody
    .replace(/c0-param1=Date:\d+/, `c0-param1=Date:${Date.now()}`)
    .replace(/batchId=\d+/, `batchId=${newBatchId}`);
}

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

async function setDateContext(jsessionId, dateKey) {
  try {
    await fetch(`https://1cs.jp/ucs/reserveService.do?StartupDate=${dateKey}`, {
      headers: { 'Cookie': `JSESSIONID=${jsessionId}`, 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow', signal: AbortSignal.timeout(10_000),
    });
  } catch { /* 無視 */ }
}

function isSessionValid(dwrText) {
  return !(!dwrText || dwrText.includes('throw') || dwrText.length < 50);
}

async function notifyStaff(newList, prevList, dateStr) {
  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.STAFF_NOTIFY_EMAIL;
  if (!apiKey || !to) return;

  const prevIds = new Set(prevList.map(r => r.id));
  const newIds  = new Set(newList.map(r => r.id));
  const added   = newList.filter(r => !prevIds.has(r.id));
  const removed = prevList.filter(r => !newIds.has(r.id));
  if (added.length === 0 && removed.length === 0) return;

  const row = r => `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee">${r.time}</td>
    <td style="padding:4px 10px;border-bottom:1px solid #eee">${r.name}</td>
    <td style="padding:4px 10px;border-bottom:1px solid #eee">${r.menu}</td>
    <td style="padding:4px 10px;border-bottom:1px solid #eee">${r.phone || '—'}</td></tr>`;
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
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'onboarding@resend.dev',
      to,
      subject: `[MONTH COLOR] ${dateStr} 予約変更通知（${added.length > 0 ? `+${added.length}` : ''}${removed.length > 0 ? ` -${removed.length}` : ''}）`,
      html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function syncOneDay(jsessionId, dwrRequests, dateStr, isToday) {
  const dateKey = dateStr.replace(/-/g, '');
  await setDateContext(jsessionId, dateKey);

  const dwrTexts = await Promise.allSettled(
    dwrRequests.map((tmpl, i) => callDwr(jsessionId, tmpl, i + 1))
  );
  const validTexts = dwrTexts.filter(r => r.status === 'fulfilled' && isSessionValid(r.value)).map(r => r.value);
  if (!validTexts.length) return { ok: false, reason: 'no valid DWR data', date: dateStr };

  const allReservations = [];
  const seenIds = new Set();
  for (const text of validTexts) {
    for (const item of extractReservations(text)) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        allReservations.push({
          id: item.id, time: startTime(item.reserveTime), timeRange: item.reserveTime,
          name: item.customerName || '不明', nameKana: item.customerNameKana || '',
          menu: item.name || '', phone: item.customerPhoneNo2 || item.customerPhoneNo || '',
          email: item.customerMailAddress || '', visitCount: item.customerReservationCount || 0,
          note: item.userComment || '', source: 'comingsoon',
        });
      }
    }
  }
  allReservations.sort((a, b) => a.time.localeCompare(b.time));

  let changed = true, prevReservations = [];
  const existing = await storage.get(`comingsoon-${dateStr}.json`);
  if (existing) {
    prevReservations = existing.reservations || [];
    if (JSON.stringify(prevReservations) === JSON.stringify(allReservations)) changed = false;
  }

  if (changed) {
    const payload = JSON.stringify({ updatedAt: new Date().toISOString(), date: dateStr, reservations: allReservations }, null, 2);
    const puts = [
      storage.put(`comingsoon-${dateStr}.json`, payload),
    ];
    // 今日分のみ comingsoon-today.json にも保存（後方互換）
    if (isToday) {
      puts.push(storage.put('comingsoon-today.json', payload));
    }
    await Promise.all(puts);
    if (isToday) {
      notifyStaff(allReservations, prevReservations, dateStr).catch(e => console.error('notify error:', e.message));
    }
  }

  return { ok: true, changed, count: allReservations.length, date: dateStr };
}

async function handleCsSync(res) {
  // 今日から7日分（今日+6日後）を同期して週間サマリー・タイムラインを全日表示可能にする
  const SYNC_DAYS = 7;
  const baseDate = new Date();
  baseDate.setTime(baseDate.getTime() + 9 * 60 * 60 * 1000); // JST

  try {
    const session = await storage.get('comingsoon-session.json');
    if (!session) return res.status(200).json({ ok: false, reason: 'no session' });
    const { jsessionId, dwrRequests } = session;
    if (!jsessionId || !dwrRequests?.length) return res.status(200).json({ ok: false, reason: 'session incomplete' });

    const todayStr = toDateStr(baseDate);
    const results = [];

    for (let i = 0; i < SYNC_DAYS; i++) {
      const d = new Date(baseDate.getTime() + i * 86400000);
      const dateStr = toDateStr(d);
      const isToday = dateStr === todayStr;
      try {
        const r = await syncOneDay(jsessionId, dwrRequests, dateStr, isToday);
        results.push(r);
      } catch (e) {
        results.push({ ok: false, date: dateStr, error: e.message });
      }
    }

    const totalCount = results.filter(r => r.ok).reduce((s, r) => s + (r.count || 0), 0);
    return res.status(200).json({ ok: true, synced: results.length, totalCount, results });
  } catch (e) {
    console.error('cs-sync error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// REMIND: 前日リマインダーメール
// ═══════════════════════════════════════════════════════════════

const QUEUE_KEY = 'reservations-queue.json';

async function handleRemind(res) {
  if (!process.env.RESEND_API_KEY) {
    return res.status(200).json({ sent: 0, skipped: true, reason: 'RESEND_API_KEY not set' });
  }

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = toDateStr(tomorrow);

  let queue = [];
  try {
    queue = (await storage.get(QUEUE_KEY)) || [];
  } catch (e) {
    return res.status(500).json({ error: 'キュー読み込み失敗' });
  }

  const targets = queue.filter(r => r.data?.date === tomorrowStr && r.data?.email && r.status !== 'cancelled');
  if (!targets.length) return res.status(200).json({ sent: 0, date: tomorrowStr });

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const results = await Promise.allSettled(targets.map(r => sendReminder(resend, r.data)));
  const sent = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  return res.status(200).json({ sent, failed, date: tomorrowStr });
}

async function sendReminder(resend, { date, time, name, menuName, email }) {
  const dateLabel = new Date(date).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  await resend.emails.send({
    from: process.env.MAIL_FROM || 'MONTH COLOR <noreply@monthcolor.jp>',
    to: email,
    subject: `【明日のご予約リマインダー】${dateLabel} ${time} — MONTH COLOR`,
    html: `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans',Meiryo,sans-serif;background:#f5f5f5;padding:32px 16px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
    <div style="background:#1a1a1a;padding:28px 32px;">
      <p style="color:#c9a87a;font-size:11px;letter-spacing:3px;margin:0 0 6px;">MONTH COLOR</p>
      <h1 style="color:#fff;font-size:20px;margin:0;font-weight:600;">明日のご予約のお知らせ</h1>
    </div>
    <div style="padding:32px;">
      <p style="color:#333;line-height:1.8;margin:0 0 24px;">${name} 様<br><br>明日のご予約のお時間が近づいてまいりました。<br>お気をつけてお越しください。</p>
      <div style="background:#f9f6f2;border-radius:10px;padding:20px 24px;margin-bottom:24px;text-align:center;">
        <p style="color:#c9a87a;font-size:11px;letter-spacing:2px;margin:0 0 8px;">YOUR APPOINTMENT</p>
        <p style="color:#1a1a1a;font-size:22px;font-weight:700;margin:0 0 4px;">${dateLabel}</p>
        <p style="color:#1a1a1a;font-size:28px;font-weight:700;margin:0 0 8px;">${time}</p>
        <p style="color:#666;font-size:14px;margin:0;">${menuName || '施術'}</p>
      </div>
      <p style="color:#888;font-size:12px;line-height:1.8;margin:0;">ご変更・キャンセルのご連絡は前日までにお電話にてお願いいたします。</p>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;border-top:1px solid #e8e8e8;">
      <p style="color:#aaa;font-size:11px;margin:0;text-align:center;">© MONTH COLOR — このメールは予約システムから自動送信されました</p>
    </div>
  </div>
</body></html>`,
  });
}

// ═══════════════════════════════════════════════════════════════
// MORNING-REPORT: LINE Notify 朝の日報
// ═══════════════════════════════════════════════════════════════

function jpDateLabel(dateStr) {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(dateStr + 'T00:00:00+09:00');
  return `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]})`;
}

async function fetchCSForReport() {
  try {
    const data = await storage.get('comingsoon-today.json');
    if (!data) return [];
    return (data.reservations || []).map(r => ({
      time: r.time || (r.reserveTime || '').split('-')[0].trim() || '??:??',
      name: r.name || r.customerName || '—',
      menu: r.menuName || r.courseName || r.course || '',
      staff: r.staffName || '',
    }));
  } catch { return []; }
}

async function fetchSBForReport(date) {
  const month = date.slice(0, 7);
  try {
    const data = await storage.get(`salonboard-${month}.json`);
    if (!data) return [];
    return ((data.reservations || {})[date] || []).map(r => ({
      time: r.time || r.startTime || '??:??',
      name: r.customerName || r.name || '—',
      menu: r.menuName || r.course || '',
      source: 'SB',
    }));
  } catch { return []; }
}

function buildMorningMessage(date, csRes, sbRes) {
  const label = jpDateLabel(date);
  const csCount = csRes.length;
  const sbSlots = sbRes.filter(r => r.time !== '??:??');

  const header = [`\n🌿 MONTH COLOR 本日の予約`, label];
  const sep = '\n' + '─'.repeat(18) + '\n';

  const csLines = csCount === 0 ? ['CS: 予約なし'] : [
    `【CS】${csCount}件`,
    ...csRes.map(r => `${r.time} ${r.name}${r.menu ? ' ' + r.menu : ''}${r.staff ? ' [' + r.staff + ']' : ''}`),
  ];

  const sbLines = sbSlots.length === 0 ? ['SB: データなし'] : (() => {
    const byTime = {};
    for (const r of sbSlots) {
      if (!byTime[r.time]) byTime[r.time] = [];
      byTime[r.time].push(r.menu || '予約');
    }
    return [`【SalonBoard】${sbSlots.length}枠`, ...Object.entries(byTime).map(([t, m]) => `${t} ×${m.length} ${[...new Set(m)][0] || ''}`)];
  })();

  let msg = header.join('\n') + sep + csLines.join('\n') + sep + sbLines.join('\n');
  if (msg.length > 3800) msg = header.join('\n') + sep + csLines.slice(0, 31).join('\n') + `\n\nSB: ${sbSlots.length}枠（省略）`;
  return msg;
}

async function handleMorningReport(res) {
  const lineToken = process.env.LINE_NOTIFY_TOKEN;
  if (!lineToken) {
    console.warn('LINE_NOTIFY_TOKEN 未設定 — 朝の日報スキップ');
    return res.status(200).json({ skipped: true, reason: 'LINE_NOTIFY_TOKEN not set' });
  }

  const date = todayJST();

  const [csRes, sbRes] = await Promise.all([fetchCSForReport(), fetchSBForReport(date)]);
  const message = buildMorningMessage(date, csRes, sbRes);
  console.log(message);

  try {
    const resp = await fetch('https://notify-api.line.me/api/notify', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${lineToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `message=${encodeURIComponent(message)}`,
    });
    if (!resp.ok) throw new Error(`LINE Notify: ${resp.status}`);
    return res.status(200).json({ sent: true, date, cs: csRes.length, sb: sbRes.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// メインハンドラ
// ═══════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!authCron(req)) return res.status(401).json({ error: 'Unauthorized' });

  const type = (req.query.type || '').trim();

  switch (type) {
    case 'cs-sync':        return handleCsSync(res);
    case 'remind':         return handleRemind(res);
    case 'morning-report': return handleMorningReport(res);
    default:
      return res.status(400).json({ error: 'type パラメータが必要 (cs-sync | remind | morning-report)' });
  }
};
