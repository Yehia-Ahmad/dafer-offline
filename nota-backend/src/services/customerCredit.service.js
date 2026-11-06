const { loadCustomerStatement } = require("./customerStatement.service");
const { roundMoney } = require("../utils/invoicePricing");

// Stage 19: a customer's credit (we owe them), from the Stage 16 statement and the Stage 18 open items.
//
//   balance     the statement's closing balance N (negative = we owe the customer)
//   credit      max(0, -N): what can be PAID OUT (Dr CUSTOMERS / Cr box)
//   openItems   what the customer still owes on open invoices and an opening balance
//   unapplied   openItems - N: credit not yet set against any open item. Setting credit against an item
//               lowers openItems and keeps N, so this falls by the same amount.
//   applicable  min(openItems, unapplied): what "apply to open invoices" can take
async function customerCreditOf(customerId, { session = null } = {}) {
  const statement = await loadCustomerStatement(customerId, { session });
  const balance = roundMoney(statement.totals.balance);
  const openItems = roundMoney(statement.outstanding || 0);
  const unapplied = roundMoney(Math.max(0, openItems - balance));
  return { balance, credit: roundMoney(Math.max(0, -balance)), openItems, unapplied, applicable: roundMoney(Math.min(openItems, unapplied)) };
}

module.exports = { customerCreditOf };
