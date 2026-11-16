// Online Stage 3: prices a website order on the server. The client only sends product ids and quantities; everything
// below comes from the database. Uses the same helpers a cash sale uses, read-only:
//   unit price  = calculatePriceAfterDiscount(retail, product discount)   (utils/productPricing)
//   line total  = roundMoney(unit price x qty), subtotal = buildInvoiceTotals(...).subtotal   (utils/invoicePricing)
//   VAT         = vatContext(loadVatSettings) + computeSaleVat   (accounting/vat, utils/vat), same inputs as priceNewInvoice
// The delivery fee is added AFTER the VAT calculation (its VAT split is decided in Stage 4).
const { calculatePriceAfterDiscount } = require("../utils/productPricing");
const { buildInvoiceTotals, roundMoney } = require("../utils/invoicePricing");
const { computeSaleVat } = require("../utils/vat");
const { loadVatSettings, vatContext, today } = require("../accounting/vat");

/**
 * @param lines    [{ product (lean doc with retailPrice, discountPercentage, vatExempt, name, code), qty }]
 * @param zone     { fee }
 * @param settings WebsiteSettings (lean) | null
 */
const priceWebOrder = async ({ lines, zone, settings, session }) => {
  const items = lines.map(({ product, qty }) => {
    const unitPrice = calculatePriceAfterDiscount(product.retailPrice, product.discountPercentage);
    return {
      productId: product._id,
      name: product.name,
      code: product.code,
      retailPrice: roundMoney(product.retailPrice),
      discountPercentage: Number(product.discountPercentage || 0),
      unitPrice,
      vatExempt: Boolean(product.vatExempt),
      qty,
      totalPrice: roundMoney(unitPrice * qty),
    };
  });
  const { subtotal } = buildInvoiceTotals(items, {});

  const context = vatContext(await loadVatSettings(session), today());
  let vat = { amount: 0, rate: undefined, included: undefined, itemVat: items.map(() => 0), goodsTotal: subtotal };
  if (context) {
    const computed = computeSaleVat({ items, discountAmount: 0, shippingFees: 0, rate: context.rate, included: context.included });
    vat = { amount: computed.vatAmount, rate: context.rate, included: context.included, itemVat: computed.itemVat, goodsTotal: computed.totalPrice };
  }

  const freeFrom = settings && settings.freeDeliveryFrom;
  const freeDelivery = freeFrom !== undefined && freeFrom !== null && subtotal >= Number(freeFrom);
  const deliveryFee = freeDelivery ? 0 : roundMoney(zone.fee);

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
    deliveryFee,
    total: roundMoney(vat.goodsTotal + deliveryFee),
  };
};

module.exports = { priceWebOrder };
