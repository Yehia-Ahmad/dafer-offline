// Online Stage 3: prices a website order on the server. The client only sends product ids and quantities; everything
// below comes from the database. Uses the same helpers a cash sale uses, read-only:
//   unit price  = calculatePriceAfterDiscount(retail, product discount)   (utils/productPricing)
//   line total  = roundMoney(unit price x qty), subtotal = buildInvoiceTotals(...).subtotal   (utils/invoicePricing)
//   VAT         = vatContext(loadVatSettings) + computeSaleVat   (accounting/vat, utils/vat), same inputs as priceNewInvoice
// Online Stage 4 (decision 9): the delivery fee goes INTO computeSaleVat as `shippingFees`, exactly like the credit sale made
// at dispatch (shipping VAT, SHIPPING_INCOME), so the order total is the invoice total to the piastre.
const { calculatePriceAfterDiscount } = require("../utils/productPricing");
const { buildInvoiceTotals, roundMoney } = require("../utils/invoicePricing");
const { computeSaleVat } = require("../utils/vat");
const { loadVatSettings, vatContext, today } = require("../accounting/vat");

/**
 * @param lines    [{ product (lean doc with retailPrice, discountPercentage, vatExempt, name, code), qty,
 *                    unitPrice? (a snapshot price kept by an edit), retailPrice?, discountPercentage? (kept with it) }]
 * @param zone     { fee }
 * @param settings WebsiteSettings (lean) | null
 * @param feeOverride a delivery fee set by staff when editing an order (skips the free-delivery rule)
 */
const priceWebOrder = async ({ lines, zone, settings, session, feeOverride }) => {
  const items = lines.map(({ product, qty, unitPrice: keptPrice, retailPrice: keptRetail, discountPercentage: keptDiscount }) => {
    const kept = keptPrice !== undefined && keptPrice !== null;
    const unitPrice = kept ? roundMoney(keptPrice) : calculatePriceAfterDiscount(product.retailPrice, product.discountPercentage);
    return {
      productId: product._id,
      name: product.name,
      code: product.code,
      retailPrice: roundMoney(kept && keptRetail !== undefined ? keptRetail : product.retailPrice),
      discountPercentage: Number((kept && keptDiscount !== undefined ? keptDiscount : product.discountPercentage) || 0),
      unitPrice,
      vatExempt: Boolean(product.vatExempt),
      qty,
      totalPrice: roundMoney(unitPrice * qty),
    };
  });
  const { subtotal } = buildInvoiceTotals(items, {});

  const freeFrom = settings && settings.freeDeliveryFrom;
  const freeDelivery = freeFrom !== undefined && freeFrom !== null && subtotal >= Number(freeFrom);
  const deliveryFee = feeOverride !== undefined && feeOverride !== null ? roundMoney(feeOverride) : (freeDelivery ? 0 : roundMoney(zone.fee));

  const context = vatContext(await loadVatSettings(session), today());
  let vat = { amount: 0, rate: undefined, included: undefined, shippingVat: 0, itemVat: items.map(() => 0), total: roundMoney(subtotal + deliveryFee) };
  if (context) {
    const computed = computeSaleVat({ items, discountAmount: 0, shippingFees: deliveryFee, rate: context.rate, included: context.included });
    vat = { amount: computed.vatAmount, rate: context.rate, included: context.included, shippingVat: computed.shippingVat, itemVat: computed.itemVat, total: computed.totalPrice };
  }

  return {
    items: items.map((item, index) => ({
      productId: item.productId,
      name: item.name,
      code: item.code,
      retailPrice: item.retailPrice,
      discountPercentage: item.discountPercentage,
      unitPrice: item.unitPrice,
      vat: vat.itemVat[index],
      vatExempt: item.vatExempt,
      qty: item.qty,
      lineTotal: item.totalPrice,
    })),
    subtotal,
    vat: vat.amount,
    vatRate: vat.rate,
    vatIncluded: vat.included,
    shippingVat: vat.shippingVat,
    deliveryFee,
    total: roundMoney(vat.total),
  };
};

module.exports = { priceWebOrder };
