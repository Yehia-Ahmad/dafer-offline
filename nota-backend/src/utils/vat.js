// Stage 21: the VAT money rules, pure functions (no database). Every amount is computed ONCE when the document is saved,
// stored on it, and posted/reported from the stored value; nothing here is called later with a different rate.
//
// Sales (cash and credit):
//   taxable gross = Σ non-exempt line totals - the invoice discount allocated by line value to the taxable lines + shipping
//   prices include VAT : vat = round2(taxable gross × rate / (100 + rate));  totalPrice unchanged
//   prices exclude VAT : vat = round2(taxable gross × rate / 100);           totalPrice = old total + vat
// Net split per account (ONE rule): shipping net = shipping - shipping VAT (inclusive) or shipping (exclusive); discount net
// (taxable part) = round2(share × 100 / (100 + rate)) (inclusive) or the share (exclusive); the exempt part of the discount is
// untaxed. Cr SALES takes the remainder, so the entry balances to the piaster and no plug account is ever used.
const round2 = (value) => Number(Number(value || 0).toFixed(2));

const monthOf = (date) => {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const nextMonth = (period) => {
  const [year, month] = period.split("-").map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
};

/** The factor that turns a taxable gross into VAT. */
const vatFactor = (rate, included) => (included ? rate / (100 + rate) : rate / 100);
const vatOf = (gross, rate, included) => round2(Math.max(0, gross) * vatFactor(rate, included));
/** Net of the VAT that is inside a gross amount (inclusive), or the amount itself (exclusive). */
const netOf = (gross, rate, included) => (included ? round2(gross * 100 / (100 + rate)) : round2(gross));

/** Spreads `total` over `weights`; every part but the last is rounded, the last takes the remainder. */
const allocateByWeight = (total, weights) => {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  let allocated = 0;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return round2(total - allocated);
    const part = sum > 0 ? round2(total * weight / sum) : 0;
    allocated = round2(allocated + part);
    return part;
  });
};

/**
 * @param items [{ totalPrice, vatExempt }]  line totals as sold (before the invoice discount)
 * @returns the VAT fields to store on the invoice (see the model) plus `itemVat` (one value per item) and `breakdown`.
 */
const computeSaleVat = ({ items, discountAmount = 0, shippingFees = 0, rate, included }) => {
  const lineTotals = items.map((item) => round2(item.totalPrice));
  const subtotal = round2(lineTotals.reduce((sum, value) => sum + value, 0));
  const discount = round2(Math.min(Math.max(discountAmount, 0), subtotal));
  const shares = allocateByWeight(discount, lineTotals);
  const taxableIdx = items.map((item, index) => (item.vatExempt ? -1 : index)).filter((index) => index >= 0);
  const discountTaxable = round2(taxableIdx.reduce((sum, index) => sum + shares[index], 0));
  const discountExempt = round2(discount - discountTaxable);
  const taxableLines = round2(taxableIdx.reduce((sum, index) => sum + lineTotals[index], 0));
  const exemptLines = round2(subtotal - taxableLines);
  const shipping = round2(shippingFees);
  const taxableGross = round2(Math.max(0, taxableLines - discountTaxable + shipping));
  const vatAmount = vatOf(taxableGross, rate, included);
  // VAT per taxable line (on its value after its discount share), then shipping. A line's VAT is never negative: the rounding
  // remainder goes to the largest taxable line (shipping only when no line is taxable) and is clamped at 0, with any deficit
  // taken back from the other components so the parts still add up to the invoice VAT.
  const components = [...taxableIdx.map((index) => ({ index, base: Math.max(0, lineTotals[index] - shares[index]) })), ...(shipping > 0 ? [{ index: -1, base: shipping }] : [])];
  const vats = components.map((component) => vatOf(component.base, rate, included));
  if (components.length) {
    let big = 0;
    components.forEach((component, i) => { if (component.index !== -1 && (components[big].index === -1 || component.base > components[big].base)) big = i; });
    if (components[big].index === -1) components.forEach((component, i) => { if (component.base > components[big].base) big = i; });
    const others = round2(vats.reduce((sum, value, i) => (i === big ? sum : sum + value), 0));
    const remainder = round2(vatAmount - others);
    vats[big] = Math.max(0, remainder);
    let deficit = remainder < 0 ? -remainder : 0;
    for (const i of vats.map((_, k) => k).filter((k) => k !== big).sort((a, b) => vats[b] - vats[a])) {
      if (deficit <= 0) break;
      const take = Math.min(vats[i], deficit);
      vats[i] = round2(vats[i] - take); deficit = round2(deficit - take);
    }
  }
  const itemVat = items.map(() => 0);
  let shippingVat = 0;
  components.forEach((component, i) => { if (component.index === -1) shippingVat = vats[i]; else itemVat[component.index] = vats[i]; });

  const totalBefore = round2(Math.max(0, subtotal - discount + shipping));
  const totalPrice = included ? totalBefore : round2(totalBefore + vatAmount);
  const netAmount = round2(totalPrice - vatAmount);
  const shippingNet = included ? round2(shipping - shippingVat) : shipping;
  const discountNet = round2(netOf(discountTaxable, rate, included) + discountExempt);
  const salesNet = round2(totalPrice - vatAmount - shippingNet + discountNet);
  return {
    vatRate: rate, vatIncluded: Boolean(included), vatAmount, shippingVat, totalPrice, netAmount,
    taxableAmount: round2(taxableGross - (included ? vatAmount : 0)), exemptAmount: round2(exemptLines - discountExempt),
    itemVat, breakdown: { salesNet, discountNet, shippingNet },
  };
};

/**
 * VAT of ONE return of a VAT invoice, by the cumulative-proportion rule.
 *  - the lines' VAT (invoice VAT - shipping VAT) is shared by returned taxable line value: cum = round2(V × cumReturnedTaxable / taxableLines);
 *    this return = cum - what earlier returns already took;
 *  - the FINAL return (isFull) takes everything left: invoice VAT - Σ earlier returned VAT, shipping VAT included;
 *  - shipping comes back only with the final return, as it already does for VAT-free invoices.
 * @param invoice  { vatRate, vatIncluded, vatAmount, shippingVat, vatReturnedAmount, items: [{ unitPrice, quantity, returnedQuantity (AFTER this return), vatExempt }] }
 * @returns { vatAmount, vatLines, vatShipping }
 */
const computeReturnVat = ({ invoice, isFull }) => {
  const priorReturned = round2(invoice.vatReturnedAmount || 0);
  const remaining = round2(invoice.vatAmount - priorReturned);
  if (isFull) {
    const vatShipping = round2(invoice.shippingVat || 0);
    return { vatAmount: Math.max(0, remaining), vatShipping, vatLines: Math.max(0, round2(remaining - vatShipping)) };
  }
  const linesVat = round2(invoice.vatAmount - (invoice.shippingVat || 0));
  const taxable = invoice.items.filter((item) => !item.vatExempt);
  const taxableValue = round2(taxable.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));
  const returnedValue = round2(taxable.reduce((sum, item) => sum + item.unitPrice * (item.returnedQuantity || 0), 0));
  const cumulative = taxableValue > 0 ? round2(linesVat * returnedValue / taxableValue) : 0;
  const vatLines = Math.min(Math.max(0, round2(cumulative - priorReturned)), Math.max(0, remaining - (invoice.shippingVat || 0)));
  return { vatAmount: vatLines, vatLines, vatShipping: 0 };
};

/**
 * The per-account net split of a return (stored on the ReturnLog, posted as is). `g` = returned line value,
 * `shipping` = returned shipping, `base` = refund without VAT on top, `taxableShare` = returned taxable value / g.
 */
const computeReturnBreakdown = ({ invoice, linesValue, taxableLinesValue, shippingReturned, shippingVat, baseRefund }) => {
  const rate = invoice.vatRate; const included = Boolean(invoice.vatIncluded);
  const discountGross = round2(Math.max(0, linesValue + shippingReturned - baseRefund));
  const discountTaxable = linesValue > 0 ? round2(discountGross * Math.min(1, taxableLinesValue / linesValue)) : 0;
  const discountExempt = round2(discountGross - discountTaxable);
  const shippingNet = included ? round2(shippingReturned - shippingVat) : round2(shippingReturned);
  const discountNet = round2(netOf(discountTaxable, rate, included) + discountExempt);
  return { discountNet, shippingNet };
};

/** vatPeriod: the business month, or the first unfiled month after it when that month's return is already filed. */
const resolvePeriod = (date, lastFiledPeriod) => {
  const period = monthOf(date);
  return lastFiledPeriod && period <= lastFiledPeriod ? nextMonth(lastFiledPeriod) : period;
};

module.exports = {
  round2, monthOf, nextMonth, vatFactor, vatOf, netOf, allocateByWeight,
  computeSaleVat, computeReturnVat, computeReturnBreakdown, resolvePeriod,
};
