const roundPrice = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const calculatePriceAfterDiscount = (retailPrice, discountPercentage = 0) => {
  const price = Number(retailPrice);
  const discount = Number(discountPercentage);

  if (!Number.isFinite(price)) return 0;
  if (!Number.isFinite(discount)) return roundPrice(price);

  return roundPrice(price * (1 - Math.min(100, Math.max(0, discount)) / 100));
};

const withProductPriceAfterDiscount = (product) => {
  if (!product) return product;

  const productObject =
    typeof product.toObject === "function" ? product.toObject() : product;

  return {
    ...productObject,
    discountPercentage: Number(productObject.discountPercentage || 0),
    priceAfterDiscount: calculatePriceAfterDiscount(
      productObject.retailPrice,
      productObject.discountPercentage
    ),
  };
};

module.exports = {
  calculatePriceAfterDiscount,
  withProductPriceAfterDiscount,
};
