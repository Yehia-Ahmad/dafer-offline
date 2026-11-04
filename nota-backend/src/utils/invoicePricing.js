const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

const resolveDiscountAmount = (subtotal, options = {}) => {
  if (
    options.discountAmount !== undefined &&
    options.discountAmount !== null &&
    options.discountAmount !== ""
  ) {
    const directDiscountAmount = Number(options.discountAmount);
    if (!Number.isFinite(directDiscountAmount) || directDiscountAmount <= 0) {
      return 0;
    }

    return roundMoney(directDiscountAmount);
  }

  const discountPercentage = Number(options.discountPercentage || 0);
  if (!Number.isFinite(discountPercentage) || discountPercentage <= 0) {
    return 0;
  }

  return roundMoney((subtotal * discountPercentage) / 100);
};

const buildInvoiceTotals = (items = [], options = {}) => {
  const totalQuantity = items.reduce(
    (sum, item) => sum + Number(item.productQuantity ?? item.quantity ?? 0),
    0
  );
  const subtotal = roundMoney(
    items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0)
  );
  const discountAmount = resolveDiscountAmount(subtotal, options);
  const shippingFees = roundMoney(
    totalQuantity > 0 ? Number(options.shippingFees || 0) : 0
  );
  const totalPrice = roundMoney(
    Math.max(0, subtotal - discountAmount + shippingFees)
  );

  return {
    totalQuantity,
    subtotal,
    discountAmount,
    shippingFees,
    totalPrice,
  };
};

module.exports = {
  roundMoney,
  buildInvoiceTotals,
};
