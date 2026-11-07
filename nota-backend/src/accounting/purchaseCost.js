const { roundMoney } = require("../utils/invoicePricing");

// Stage 20: the pure cost rules of a purchase (no database).

const round4 = (value) => Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;

/**
 * Splits (otherCosts - discount) over the lines by line value. Every line but the last gets a rounded share;
 * the last absorbs the remainder, so Σ lineCost = subtotal - discount + otherCosts exactly.
 * @param {number[]} lineTotals value of each line (qty × price)
 * @returns {{ lineCosts: number[], subtotal: number, total: number }}
 */
const allocateCosts = (lineTotals, discountAmount = 0, otherCosts = 0) => {
  const subtotal = roundMoney(lineTotals.reduce((sum, value) => sum + value, 0));
  const total = roundMoney(subtotal - discountAmount + otherCosts);
  const net = roundMoney(otherCosts - discountAmount);
  const lineCosts = [];
  let allocated = 0;
  lineTotals.forEach((value, index) => {
    if (index === lineTotals.length - 1) { lineCosts.push(roundMoney(total - allocated)); return; }
    const cost = roundMoney(value + (subtotal > 0 ? (net * value) / subtotal : 0));
    lineCosts.push(cost); allocated = roundMoney(allocated + cost);
  });
  return { lineCosts, subtotal, total };
};

/**
 * Moving weighted average of the product cost. oldQty <= 0 (no stock, or negative stock): the purchase cost wins.
 * @returns {number} the new cost, 2 decimals
 */
const weightedAverage = (oldQty, oldCost, qty, lineCost) => {
  const old = Number(oldQty || 0);
  if (old <= 0) return roundMoney(lineCost / qty);
  return roundMoney((old * Number(oldCost || 0) + lineCost) / (old + qty));
};

module.exports = { allocateCosts, weightedAverage, round4 };
