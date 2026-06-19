/**
 * api/router.js — 単一 API エントリーポイント
 * vercel.json から `?name=<handler>` で呼ばれる。
 * server.js は app.all('/api/:name', ...) でここに委譲する。
 */

// 旧パス名 → 実ハンドラー名
const ALIAS = {
  'comingsoon-today':    'comingsoon',
  'comingsoon-date':     'comingsoon',
  'salonboard-date':     'salonboard',
  'slots':               'salonboard',
  'today-reservations':  'salonboard',
  'cron-cs-sync':        'cron',
  'cron-remind':         'cron',
  'cron-morning-report': 'cron',
};

// エイリアス呼び出し時に自動注入する query params
const QUERY_INJECT = {
  'today-reservations':  { today: '1' },
  'cron-cs-sync':        { type: 'cs-sync' },
  'cron-remind':         { type: 'remind' },
  'cron-morning-report': { type: 'morning-report' },
};

// 許可済みハンドラーの allowlist（パストラバーサル防止）
const HANDLERS = {
  'admin-action':  require('./_handlers/admin-action'),
  'checkin':       require('./_handlers/checkin'),
  'checkout':      require('./_handlers/checkout'),
  'close':         require('./_handlers/close'),
  'comingsoon':    require('./_handlers/comingsoon'),
  'cron':          require('./_handlers/cron'),
  'customer-note': require('./_handlers/customer-note'),
  'customers':     require('./_handlers/customers'),
  'menu':          require('./_handlers/menu'),
  'products':      require('./_handlers/products'),
  'receipt':       require('./_handlers/receipt'),
  'reservations':  require('./_handlers/reservations'),
  'reserve':       require('./_handlers/reserve'),
  'sales':         require('./_handlers/sales'),
  'salonboard':    require('./_handlers/salonboard'),
};

module.exports = async function router(req, res) {
  const rawName = (req.query.name || '').toString();

  if (QUERY_INJECT[rawName]) {
    Object.assign(req.query, QUERY_INJECT[rawName]);
  }

  const name = ALIAS[rawName] || rawName;
  const handler = HANDLERS[name];

  if (!handler) {
    return res.status(404).json({ error: 'Not found', path: rawName });
  }

  return handler(req, res);
};
