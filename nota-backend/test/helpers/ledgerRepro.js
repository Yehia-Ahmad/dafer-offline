// Stage 17 review: the reviewer's ledger repro scenarios, driven only over HTTP so
// the same steps run in test/stage17.test.js (in-process, auth on) and in
// scripts/legacy-migration.js (real pre-Stage-16 data, auth off).
//
// After every step it asserts:
//   - every /api/accounting/health check has difference 0;
//   - each listed customer's ledger party balance = their Stage 16 statement balance;
//   - CASH_MAIN = a cash total tracked here from the documents' own amounts.
const assert = require("node:assert/strict");

const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const flatten = (rows) => rows.flatMap((row) => [row, ...flatten(row.children || [])]);

function createLedgerChecker(call) {
  const steps = [];
  let trackedCash = 0;
  const ok = async (method, path, body) => {
    const response = await call(method, path, body);
    assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(response.json)}`);
    return response.json;
  };
  async function verify(label, customerIds) {
    const health = await ok("GET", "/api/accounting/health");
    for (const [name, check] of Object.entries(health)) {
      assert.equal(check.difference, 0, `${label}: health ${name} ${JSON.stringify(check)}`);
    }
    const accounts = flatten((await ok("GET", "/api/accounting/accounts")).accounts);
    const cash = accounts.find((account) => account.systemKey === "CASH_MAIN");
    const customersAccount = accounts.find((account) => account.systemKey === "CUSTOMERS");
    assert.equal(round(cash.balance), round(trackedCash), `${label}: CASH_MAIN ${cash.balance} vs tracked ${trackedCash}`);
    const perCustomer = [];
    for (const id of customerIds) {
      const statement = await ok("GET", `/api/customers/${id}/statement`);
      const ledger = await ok("GET", `/api/accounting/accounts/${customersAccount._id}/ledger?partyId=${id}`);
      assert.equal(round(ledger.balance), round(statement.totals.balance), `${label}: customer ${id} ledger ${ledger.balance} vs statement ${statement.totals.balance}`);
      perCustomer.push(statement.totals.balance);
    }
    steps.push({ label, health: Object.fromEntries(Object.entries(health).map(([name, check]) => [name, check.difference])), cash: round(trackedCash), customers: perCustomer.length });
  }
  return {
    ok, verify, steps,
    addCash(amount) { trackedCash = round(trackedCash + Number(amount)); },
    get cash() { return trackedCash; },
  };
}

/**
 * @param {object} args
 * @param {Function} args.call (method, path, body) → { status, json }
 * @param {string} args.productId product A (purchase price 20, enough stock)
 * @param {string} args.customerId a customer for the new credit invoices
 * @param {object} args.pre pre-ledger invoices: { cashEdit (cash, no returns),
 *   cashWithReturn (cash, already partly returned before the ledger),
 *   creditDown (credit with a down payment, no returns or later payments),
 *   creditOpen (credit, open, may have returns) }
 * @param {string[]} args.customerIds every customer to compare ledger vs statement
 * @param {object} [args.checker] an existing checker (keeps its tracked cash)
 */
async function runLedgerRepro({ call, productId, customerId, pre, customerIds, checker = createLedgerChecker(call) }) {
  const { ok, verify } = checker;
  const ids = [...new Set([...customerIds, customerId].map(String))];
  const sale = (quantity) => ({ customerName: "Repro cash", customerPhone: "01017179999", sellingDate: "2026-11-05", items: [{ productId, quantity, price: 100 }] });
  const credit = (quantity, down = 0) => ({ customerId, sellingDate: "2026-11-05", items: [{ productId, quantity, price: 100 }], ...(down ? { initialPaidAmount: down, initialPaymentDate: "2026-11-05" } : {}) });
  const journal = async (query) => (await ok("GET", `/api/accounting/journal?limit=100&${query}`)).data;
  const results = {};

  await verify("upgrade", ids);

  // 1. Sales after the upgrade (new invoices), and a receipt on a pre-ledger invoice.
  const s1 = await ok("POST", "/api/sellings", sale(4)); checker.addCash(400);
  const s2 = await ok("POST", "/api/sellings", sale(3)); checker.addCash(300);
  const s3 = await ok("POST", "/api/sellings", sale(2)); checker.addCash(200);
  const c1 = await ok("POST", "/api/credit-sales", credit(2, 40)); checker.addCash(40);
  const c2 = await ok("POST", "/api/credit-sales", credit(1, 25)); checker.addCash(25);
  await ok("POST", `/api/credit-sales/${pre.creditOpen}/payments`, { amount: 30, paymentDate: "2026-11-05" }); checker.addCash(30);
  await verify("sale", ids);

  // 2. Purchase price 20 → 25.
  await ok("PUT", `/api/products/${productId}`, { purchasePrice: 25 });
  await verify("price change", ids);

  // 3. Returns after the price change: new cash invoice, pre-ledger cash invoice, pre-ledger credit invoice.
  const s1Doc = await ok("GET", `/api/sellings/${s1._id}`);
  await ok("POST", "/api/returns", { returnType: "cash", invoiceId: s1._id, items: [{ itemId: s1Doc.items[0]._id, quantity: 1 }], returnDate: "2026-11-06" }); checker.addCash(-100);
  const legacyCash = await ok("GET", `/api/sellings/${pre.cashWithReturn}`);
  const legacyReturn = await ok("POST", "/api/returns", { returnType: "cash", invoiceId: pre.cashWithReturn, items: [{ itemId: legacyCash.items[0]._id, quantity: 1 }], returnDate: "2026-11-06" });
  checker.addCash(-legacyReturn.data.returnLog.finalReturnedAmount);
  const legacyCredit = await ok("GET", `/api/credit-sales/${pre.creditOpen}`);
  await ok("POST", "/api/returns", { returnType: "credit", invoiceId: pre.creditOpen, items: [{ itemId: legacyCredit.items[0]._id, quantity: 1 }], returnDate: "2026-11-06" });
  await verify("return after price change", ids);

  // 4. Edits: new cash (3 → 1), pre-ledger cash (+1 unit), new credit (2 → 3).
  await ok("PUT", `/api/sellings/${s2._id}`, { items: [{ productId, quantity: 1, price: 100 }] }); checker.addCash(-200);
  const cashEditBefore = await ok("GET", `/api/sellings/${pre.cashEdit}`);
  const editedLegacy = await ok("PUT", `/api/sellings/${pre.cashEdit}`, { items: [{ productId, quantity: Number(cashEditBefore.items[0].productQuantity) + 1, price: 100 }] });
  checker.addCash(round(editedLegacy.totalPrice - cashEditBefore.totalPrice));
  await ok("PUT", `/api/credit-sales/${c1._id}`, { items: [{ productId, quantity: 3, price: 100 }] });
  await verify("edit", ids);

  // 5. Cash cancels: the edited new invoice, and the pre-ledger invoice returned before and after the upgrade.
  const s2Cancel = await ok("POST", `/api/sellings/${s2._id}/cancel`, { reason: "repro cancel new" });
  assert.equal(s2Cancel.cancelRefundAmount, 100); checker.addCash(-100);
  const legacyBefore = await ok("GET", `/api/sellings/${pre.cashWithReturn}`);
  const legacyCancel = await ok("POST", `/api/sellings/${pre.cashWithReturn}/cancel`, { reason: "repro cancel pre-ledger" });
  const legacyRefund = round(legacyBefore.totalPrice - legacyBefore.refundedAmount);
  assert.equal(legacyCancel.cancelRefundAmount, legacyRefund); checker.addCash(-legacyRefund);
  await verify("cancel", ids);

  // 6. Credit cancels with a down payment: new and pre-ledger.
  await ok("POST", `/api/credit-sales/${c2._id}/cancel`, { reason: "repro credit cancel new" }); checker.addCash(-25);
  const downBefore = await ok("GET", `/api/credit-sales/${pre.creditDown}`);
  const downCancel = await ok("POST", `/api/credit-sales/${pre.creditDown}/cancel`, { reason: "repro credit cancel pre-ledger" });
  const downPaid = round((downBefore.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
  assert.equal(downCancel.cancelRefundAmount, downPaid); checker.addCash(-downPaid);
  await verify("credit cancel with down payment", ids);

  // 7. Sync purchase price (25) to every invoice of product A.
  await ok("POST", `/api/products/${productId}/sync-purchase-price`, {});
  const syncEntries = await journal("sourceType=cost_sync");
  results.costSync = syncEntries.map((entry) => ({ invoice: String(entry.source.id), number: entry.source.number, cogs: entry.lines.find((row) => row.accountCode === "510")?.debit || 0 }));
  // Only active ledger invoices still carrying cost 20: s1 (4 sold − 1 returned = 3 × 5) and s3 (2 × 5).
  assert.deepEqual(results.costSync.map((row) => [row.invoice, row.cogs]).sort(), [[String(s1._id), 15], [String(s3._id), 10]].sort());
  await verify("sync", ids);

  // 8. Cancel after the sync: its cost_sync entry is reversed with the sale and the return.
  const s1Cancel = await ok("POST", `/api/sellings/${s1._id}/cancel`, { reason: "repro cancel after sync" });
  assert.equal(s1Cancel.cancelRefundAmount, 300); checker.addCash(-300);
  const s1Sync = (await journal(`sourceType=cost_sync&sourceId=${s1._id}`)).filter((entry) => entry.type === "auto");
  assert.equal(s1Sync.length, 1); assert.ok(s1Sync[0].reversedBy, "cancel reverses the invoice's cost_sync entry");
  await verify("cancel after sync", ids);

  // 9. Edit after the sync: the sale and its cost_sync entry are reversed, the sale is re-posted at the line cost.
  await ok("PUT", `/api/sellings/${s3._id}`, { items: [{ productId, quantity: 1, price: 100 }] }); checker.addCash(-100);
  const s3Entries = await journal(`sourceId=${s3._id}`);
  const s3Open = s3Entries.filter((entry) => entry.type === "auto" && !entry.reversedBy);
  assert.equal(s3Open.filter((entry) => entry.source.type === "sale").length, 1);
  assert.equal(s3Open.filter((entry) => entry.source.type === "cost_sync").length, 0, "edit reverses the cost_sync entry");
  assert.equal(s3Open.find((entry) => entry.source.type === "sale").lines.find((row) => row.accountCode === "510").debit, 25);
  await verify("edit after sync", ids);

  return { steps: checker.steps, results, cash: checker.cash };
}

module.exports = { createLedgerChecker, runLedgerRepro };
