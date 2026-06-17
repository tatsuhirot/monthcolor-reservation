/**
 * lib/checkout.js — 会計の純粋計算関数（副作用なし・ストレージ非依存）
 * 小計／割引／内税／お釣り／伝票No採番をここに集約しテスト可能にする。
 */

function calcSubtotal(items) {
  return (items || []).reduce(
    (s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
}

function applyDiscount(subtotal, discount) {
  let discountAmount = 0;
  if (discount && Number(discount.value) > 0) {
    if (discount.type === 'percent') {
      discountAmount = Math.round(subtotal * Number(discount.value) / 100);
    } else { // 'amount'
      discountAmount = Number(discount.value);
    }
  }
  discountAmount = Math.min(discountAmount, subtotal); // 合計超過を0クランプ
  const total = Math.max(subtotal - discountAmount, 0);
  return { discountAmount, total };
}

function calcTax(total) {
  return Math.round(total - total / 1.1); // 内税10%
}

function calcChange(total, tendered) {
  if (Number(tendered) < total) throw new Error('預かり金額が合計より少ないです');
  return Number(tendered) - total;
}

function nextSlipNo(date, salesSameDay) {
  const ymd = String(date).replace(/-/g, '');
  return `${ymd}-${String((salesSameDay || 0) + 1).padStart(3, '0')}`;
}

function computeCheckout({ items, discount, payment, tendered }) {
  const subtotal = calcSubtotal(items);
  const { discountAmount, total } = applyDiscount(subtotal, discount || { type: 'amount', value: 0 });
  const taxIncluded = calcTax(total);
  const change = payment === 'cash' ? calcChange(total, tendered) : null;
  return { subtotal, discountAmount, total, taxIncluded, change };
}

module.exports = { calcSubtotal, applyDiscount, calcTax, calcChange, nextSlipNo, computeCheckout };
