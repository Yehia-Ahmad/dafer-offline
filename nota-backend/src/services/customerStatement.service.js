const CreditSale = require("../models/creditSale.model");
const ReturnLog = require("../models/returnLog.model");
const { roundMoney } = require("../utils/invoicePricing");

// Stage 16 customer statement. The HTTP handler, the ledger opening entry
// (Stage 17 migration) and the accounting health check all call this one
// function so the three can never drift apart.

/**
 * Statement for one customer from already-loaded documents.
 * @param {object} args
 * @param {Array} args.invoices the customer's credit invoices (lean)
 * @param {Map<string, object>} args.returnById credit return logs by id
 * @param {Date|null} [args.from]
 * @param {Date|null} [args.to]
 */
function computeCustomerStatement({ invoices, returnById, from = null, to = null }) {
  const ordered = [...invoices].sort((left, right) =>
    new Date(left.sellingDate) - new Date(right.sellingDate) ||
    new Date(left.createdAt || 0) - new Date(right.createdAt || 0) ||
    String(left._id).localeCompare(String(right._id)));
  const lines = [];
  let sequence = 0;
  const add = (line) => lines.push({ ...line, debit: roundMoney(line.debit), credit: roundMoney(line.credit), _sequence: sequence++ });

  for (const invoice of ordered) {
    add({
      date: invoice.sellingDate, type: "invoice", number: invoice.number,
      description: `فاتورة آجل ${invoice.number || ""}`.trim(), debit: invoice.totalPrice, credit: 0,
    });
    for (const payment of invoice.payments || []) {
      if (payment.source === "return_reallocation") continue;
      add({
        date: payment.paymentDate, type: "payment", number: payment.number,
        description: payment.source === "down_payment" ? "دفعة مقدمة" : "دفعة عميل",
        debit: 0, credit: payment.amount,
      });
    }
    for (const refund of invoice.refunds || []) {
      const returnLog = refund.returnLog ? returnById.get(refund.returnLog.toString()) : null;
      add({
        date: refund.refundDate, type: "return",
        number: returnLog?.number ?? null,
        description: "مرتجع فاتورة آجل", debit: 0,
        credit: returnLog ? returnLog.finalReturnedAmount : refund.totalAmount,
      });
    }
    if (invoice.status === "cancelled") {
      add({
        date: invoice.cancelledAt || invoice.updatedAt, type: "cancel", number: invoice.number,
        description: "إلغاء فاتورة آجل", debit: 0, credit: invoice.totalPrice,
      });
      const downPayment = (invoice.payments || []).find((payment) => payment.source === "down_payment");
      if (Number(invoice.cancelRefundAmount || 0) > 0) {
        add({
          date: invoice.cancelledAt || invoice.updatedAt, type: "cancel", number: downPayment?.number || null,
          description: "رد المقدم", debit: invoice.cancelRefundAmount, credit: 0,
        });
      }
    }
  }

  lines.sort((left, right) => new Date(left.date) - new Date(right.date) || left._sequence - right._sequence);
  const openingBalance = roundMoney(lines.filter((line) => from && new Date(line.date) < from)
    .reduce((balance, line) => balance + line.debit - line.credit, 0));
  const visible = lines.filter((line) => (!from || new Date(line.date) >= from) && (!to || new Date(line.date) <= to));
  let balance = openingBalance;
  const responseLines = [];
  if (from) {
    responseLines.push({ date: from, type: "opening", number: null, description: "رصيد افتتاحي", debit: 0, credit: 0, balance });
  }
  for (const line of visible) {
    balance = roundMoney(balance + line.debit - line.credit);
    const { _sequence, ...publicLine } = line;
    responseLines.push({ ...publicLine, balance });
  }
  const totalDebit = roundMoney(visible.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = roundMoney(visible.reduce((sum, line) => sum + line.credit, 0));
  return { lines: responseLines, totals: { openingBalance, debit: totalDebit, credit: totalCredit, balance } };
}

/** Loads one customer's invoices and credit returns, then computes the statement. */
async function loadCustomerStatement(customerId, { from = null, to = null, session = null } = {}) {
  const invoices = await CreditSale.find({ customer: customerId }).sort({ sellingDate: 1, createdAt: 1, _id: 1 }).session(session).lean();
  const returns = await ReturnLog.find({ returnType: "credit", invoiceId: { $in: invoices.map((invoice) => invoice._id) } }).session(session).lean();
  return computeCustomerStatement({ invoices, returnById: new Map(returns.map((entry) => [entry._id.toString(), entry])), from, to });
}

/**
 * Closing statement balance for every customer in `customers`, from one load of
 * all credit invoices and credit returns. Used by the ledger opening entry and
 * the accounting health check.
 */
async function customerStatementBalances(customers, { session = null } = {}) {
  const [invoices, returns] = await Promise.all([
    CreditSale.find({}).session(session).lean(),
    ReturnLog.find({ returnType: "credit" }).session(session).lean(),
  ]);
  const returnById = new Map(returns.map((entry) => [entry._id.toString(), entry]));
  const byCustomer = new Map();
  for (const invoice of invoices) {
    const key = String(invoice.customer);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(invoice);
  }
  const known = new Set(customers.map((customer) => String(customer._id)));
  const orphanInvoices = invoices.filter((invoice) => !known.has(String(invoice.customer)));
  const balances = new Map();
  for (const customer of customers) {
    const statement = computeCustomerStatement({ invoices: byCustomer.get(String(customer._id)) || [], returnById });
    balances.set(String(customer._id), statement.totals.balance);
  }
  return { balances, orphanInvoices };
}

module.exports = { computeCustomerStatement, loadCustomerStatement, customerStatementBalances };
