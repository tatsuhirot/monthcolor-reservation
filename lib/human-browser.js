/**
 * human-browser.js — Bright Data Scraping Browser 接続モジュール
 *
 * Bright Data Scraping Browser を使用してAkamai Bot Managerを回避します。
 * - 本物のブラウザフィンガープリント
 * - IPローテーション自動対応
 * - UA・TLS・Canvas等の検出回避済み
 *
 * .env に以下を設定:
 *   BRIGHTDATA_WS_URL=wss://brd-customer-XXXXXX-zone-ZONENAME:PASSWORD@brd.superproxy.io:9222
 *
 * フォールバック（BRIGHTDATA_WS_URL未設定時）:
 *   ローカルFirefox（ログイン用・住宅IP環境）
 *
 * 使い方:
 *   const { launchHumanBrowser, humanClick, humanType, randomDelay } = require('./lib/human-browser');
 *   const { browser, context, page } = await launchHumanBrowser();
 */

const { chromium, firefox } = require('playwright');
const fs = require('fs');

// ── ランダム遅延 ──────────────────────────────────────────────────────
async function randomDelay(minMs = 600, maxMs = 1800) {
  const ms = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  await new Promise(r => setTimeout(r, ms));
}

// ── 人間らしいマウス移動 → クリック ─────────────────────────────────
async function humanClick(page, selector) {
  const el = await page.waitForSelector(selector, { timeout: 15000 });
  const box = await el.boundingBox();
  if (!box) { await el.click(); return; }

  const x = box.x + box.width  * (0.4 + Math.random() * 0.2);
  const y = box.y + box.height * (0.4 + Math.random() * 0.2);

  // マウスを曲線的に移動してからクリック
  const startX = Math.random() * 600 + 100;
  const startY = Math.random() * 300 + 100;
  await page.mouse.move(startX, startY);
  await randomDelay(60, 180);
  const midX = (startX + x) / 2 + (Math.random() - 0.5) * 80;
  const midY = (startY + y) / 2 + (Math.random() - 0.5) * 50;
  await page.mouse.move(midX, midY, { steps: 12 });
  await randomDelay(40, 120);
  await page.mouse.move(x, y, { steps: 8 });
  await randomDelay(60, 160);
  await page.mouse.click(x, y);
}

// ── 人間らしいタイピング ──────────────────────────────────────────────
async function humanType(page, selector, text) {
  await humanClick(page, selector);
  await randomDelay(200, 500);
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.random() * 100 + 50 });
  }
}

// ── ブラウザ起動 ─────────────────────────────────────────────────────
async function launchHumanBrowser(statePath = null) {
  const wsCdpUrl = process.env.BRIGHTDATA_WS_URL;

  if (wsCdpUrl) {
    // ── Bright Data Scraping Browser（本番・VPS用）───────────────────
    console.log('🌐 Bright Data Scraping Browser に接続中...');
    const browser = await chromium.connectOverCDP(wsCdpUrl);
    const context = browser.contexts()[0] || await browser.newContext();

    // stateファイルのCookieをBright Dataコンテキストに注入
    if (statePath && fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (state.cookies?.length) {
        await context.addCookies(state.cookies);
        console.log(`🍪 セッションCookie注入済み (${state.cookies.length}件)`);
      }
    }

    const page = await context.newPage();
    console.log('✅ Bright Data 接続完了（IP自動ローテーション・Bot回避済み）');
    return { browser, context, page, isBrightData: true };

  } else {
    // ── ローカル実Chrome（channel: 'chrome'）で起動 ────────────────
    // Cookieは実Chromeから取得しているため、同じChromeで送信しないと
    // Akamaiのフィンガープリント照合に落ちてPOSTがリセットされる
    const proxyServer   = process.env.PROXY_SERVER;
    const proxyUser     = process.env.PROXY_USERNAME;
    const proxyPass     = process.env.PROXY_PASSWORD;

    const launchOptions = {
      channel: 'chrome',
      headless: false, // headlessはAkamaiに検知されやすい
    };
    if (proxyServer) {
      launchOptions.proxy = {
        server:   proxyServer,
        username: proxyUser  || undefined,
        password: proxyPass  || undefined,
      };
      console.log(`🌐 実Chrome + Proxy で起動 (${proxyServer})`);
    } else {
      console.log('🌐 ローカル実Chrome で起動（プロキシなし）');
    }

    const browser = await chromium.launch(launchOptions);

    const contextOptions = {};
    if (statePath && fs.existsSync(statePath)) {
      contextOptions.storageState = statePath;
    }

    const context = await browser.newContext(contextOptions);
    const page    = await context.newPage();
    return { browser, context, page, isBrightData: false };
  }
}

module.exports = { launchHumanBrowser, humanClick, humanType, randomDelay };
