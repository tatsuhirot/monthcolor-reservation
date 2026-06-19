/**
 * lib/close.js — レジ締めの純粋計算関数（副作用なし・ストレージ非依存）
 * 金種合計／理論在高／過不足／入金額を集約しテスト可能にする。
 */

const DENOMS = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1];
const DEFAULT_FLOAT = 30000;

// 金種別枚数 → 実在高。負/NaN/未指定は0、小数は切り捨て。
function countCash(denominations) {
  const d = denominations || {};
  return DENOMS.reduce((sum, denom) => {
    const n = Number(d[denom]);
    return sum + (Number.isFinite(n) && n > 0 ? denom * Math.floor(n) : 0);
  }, 0);
}

// 締めの確定計算（純粋）
// 入力: { float, cashSales, denominations }
// 出力: { countedCash, expectedCash, overShort, deposit }
function computeClose({ float, cashSales, denominations }) {
  const f  = Math.max(0, Number(float) || 0);
  const cs = Math.max(0, Number(cashSales) || 0);
  const countedCash  = countCash(denominations);
  const expectedCash = f + cs;
  const overShort    = countedCash - expectedCash;
  const deposit      = Math.max(0, countedCash - f);
  return { countedCash, expectedCash, overShort, deposit };
}

module.exports = { DENOMS, DEFAULT_FLOAT, countCash, computeClose };
