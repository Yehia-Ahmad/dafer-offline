const { buildInvoiceTotals } = require("./invoicePricing");

const getCreditSaleItemProductId = (item) => {
  if (
    item.product &&
    typeof item.product === "object" &&
    item.product._id !== undefined
  ) {
    return item.product._id;
  }

  return item.product;
};

const toCreditSalePayment = (payment) => ({
  _id: payment._id,
  amount: payment.amount,
  paymentDate: payment.paymentDate,
  note: payment.note ?? null,
});

const toCreditSaleRefundItem = (item, options = {}) => {
  const refundItem = {
    _id: item._id,
    invoiceItemId: item.invoiceItemId,
    productId: getCreditSaleItemProductId(item),
    productName: item.productName,
    categoryName: item.categoryName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    totalPrice: item.totalPrice,
  };

  if (options.includeProductCode) {
    refundItem.productCode =
      item.product && typeof item.product === "object" ? item.product.code ?? null : null;
  }

  return refundItem;
};

const toCreditSaleRefund = (refund, options = {}) => ({
  _id: refund._id,
  refundDate: refund.refundDate,
  note: refund.note ?? null,
  totalQuantity: refund.totalQuantity,
  totalAmount: refund.totalAmount,
  returnedPaidAmount: refund.returnedPaidAmount ?? 0,
  reallocatedPaidAmount: refund.reallocatedPaidAmount ?? 0,
  returnLogId: refund.returnLog ?? null,
  items: Array.isArray(refund.items)
    ? refund.items.map((item) => toCreditSaleRefundItem(item, options))
    : [],
});

const toCreditSaleInvoiceItem = (item, creditSale, options = {}) => {
  const creditHistoryItem = {
    _id: item._id ?? null,
    invoiceId: creditSale._id,
    productId: getCreditSaleItemProductId(item),
    productName: item.productName,
    categoryName: item.categoryName,
    productQuantity: item.quantity,
    productQuentity: item.quantity,
    sellingDate: creditSale.sellingDate,
    dueDate: creditSale.dueDate ?? null,
    customerId: creditSale.customer,
    customerName: creditSale.customerName,
    customerPhone: creditSale.customerPhone,
    productPricePerEach: item.unitPrice,
    purchasePrice: item.purchasePrice ?? 0,
    profitAmount: item.profitAmount ?? 0,
    totalPrice: item.totalPrice,
  };

  if (options.includeProductCode) {
    creditHistoryItem.productCode =
      item.product && typeof item.product === "object" ? item.product.code ?? null : null;
  }

  return creditHistoryItem;
};

const toCreditSaleInvoice = (creditSale, options = {}) => {
  const items = Array.isArray(creditSale.items)
    ? creditSale.items.map((item) => toCreditSaleInvoiceItem(item, creditSale, options))
    : [];
  const payments = Array.isArray(creditSale.payments)
    ? creditSale.payments.map(toCreditSalePayment)
    : [];
  const refunds = Array.isArray(creditSale.refunds)
    ? creditSale.refunds.map((refund) => toCreditSaleRefund(refund, options))
    : [];
  const totals = buildInvoiceTotals(items, {
    discountAmount: creditSale.discountAmount,
    discountPercentage: creditSale.discountPercentage,
    shippingFees: creditSale.shippingFees,
  });

  return {
    _id: creditSale._id,
    invoiceId: creditSale._id,
    customerId: creditSale.customer,
    customerName: creditSale.customerName,
    customerPhone: creditSale.customerPhone,
    sellingDate: creditSale.sellingDate,
    dueDate: creditSale.dueDate ?? null,
    status: creditSale.status,
    notes: creditSale.notes ?? null,
    itemCount: items.length,
    refundCount: refunds.length,
    totalQuantity: creditSale.totalQuantity ?? totals.totalQuantity,
    discountAmount: totals.discountAmount,
    shippingFees: creditSale.shippingFees ?? totals.shippingFees,
    totalPrice: creditSale.totalPrice ?? totals.totalPrice,
    totalProfit: Number(
      (
        items.reduce((sum, item) => sum + Number(item.profitAmount || 0), 0) - totals.discountAmount
      ).toFixed(2)
    ),
    paidAmount: creditSale.paidAmount,
    remainingAmount: creditSale.remainingAmount,
    refundDueAmount: creditSale.refundDueAmount ?? 0,
    refundStatus: creditSale.refundStatus ?? "none",
    refundedQuantity: creditSale.refundedQuantity ?? 0,
    refundedAmount: creditSale.refundedAmount ?? 0,
    returnedPaidAmount: creditSale.returnedPaidAmount ?? 0,
    reallocatedPaidAmount: creditSale.reallocatedPaidAmount ?? 0,
    payments,
    refunds,
    items,
    createdAt: creditSale.createdAt,
    updatedAt: creditSale.updatedAt,
  };
};

const buildCreditSaleSummary = (creditSales) =>
  creditSales.reduce(
    (summary, creditSale) => {
      const totalPrice = Number(creditSale.totalPrice || 0);
      const paidAmount = Number(creditSale.paidAmount || 0);
      const remainingAmount = Number(creditSale.remainingAmount || 0);
      const refundDueAmount = Number(creditSale.refundDueAmount || 0);
      const returnedPaidAmount = Number(creditSale.returnedPaidAmount || 0);
      const reallocatedPaidAmount = Number(creditSale.reallocatedPaidAmount || 0);

      summary.totalInvoices += 1;
      summary.totalCreditAmount += totalPrice;
      summary.totalPaidAmount += paidAmount;
      summary.totalRemainingAmount += remainingAmount;
      summary.totalRefundDueAmount += refundDueAmount;
      summary.totalReturnedPaidAmount += returnedPaidAmount;
      summary.totalReallocatedPaidAmount += reallocatedPaidAmount;
      summary.totalDebtAmount += totalPrice;
      summary.paidAmount += paidAmount;
      summary.remainingAmount += remainingAmount;

      if (creditSale.status === "paid") {
        summary.paidInvoices += 1;
        summary.debtStatusSummary.paid += 1;
      } else if (creditSale.status === "Reactionary") {
        summary.reactionaryInvoices += 1;
        summary.debtStatusSummary.reactionary += 1;
      } else if (creditSale.status === "partially_paid") {
        summary.openInvoices += 1;
        summary.debtStatusSummary.partiallyPaid += 1;
      } else {
        summary.openInvoices += 1;
        summary.debtStatusSummary.pending += 1;
      }

      return summary;
    },
    {
      totalInvoices: 0,
      openInvoices: 0,
      paidInvoices: 0,
      reactionaryInvoices: 0,
      totalCreditAmount: 0,
      totalPaidAmount: 0,
      totalRemainingAmount: 0,
      totalRefundDueAmount: 0,
      totalReturnedPaidAmount: 0,
      totalReallocatedPaidAmount: 0,
      totalDebtAmount: 0,
      paidAmount: 0,
      remainingAmount: 0,
      debtStatusSummary: {
        pending: 0,
        partiallyPaid: 0,
        paid: 0,
        reactionary: 0,
      },
    }
  );

module.exports = {
  toCreditSaleInvoice,
  buildCreditSaleSummary,
};
