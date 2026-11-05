process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage16-test-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");

const app = require("../src/app");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const CreditSale = require("../src/models/creditSale.model");
const Customer = require("../src/models/customer.model");
const Product = require("../src/models/product.model");
const ReturnLog = require("../src/models/returnLog.model");
const Selling = require("../src/models/selling.model");
const AuditLog = require("../src/models/auditLog.model");
const Meta = require("../src/models/meta.model");
const Receipt = require("../src/models/receipt.model");
const { runMigrations } = require("../src/migrations");
const { withTransaction } = require("../src/utils/transaction");
const { importCategories } = require("../src/services/categoryImportExport.service");
const { createCategoryWorkbook } = require("../src/helpers/categoryWorkbook.helper");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

let stop;
let server;
let baseUrl;
let authToken;

test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27116 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (stop) await stop();
});

test.beforeEach(async () => {
  if (!mongodSkipReason) {
    await clearDatabase();
    authToken = null;
    const owner = await call("POST", "/api/auth/setup-owner", { name: "مالك", username: "stage16-owner", password: "owner-pass-123" });
    assert.equal(owner.status, 201, JSON.stringify(owner.json));
    authToken = owner.json.token;
  }
});

const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);
const call = async (method, path, body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};

async function catalog(stock = 10) {
  const category = await Category.create({ name: `فئة ${Math.random()}` });
  const product = await Product.create({
    name: "صنف", code: `S16-${Math.random()}`, category: category._id,
    inventoryCount: stock, soldItemCount: 0, purchasePrice: 20, wholesalePrice: 30, retailPrice: 100,
  });
  return { category, product };
}

const saleBody = (product, quantity = 1, price = 100, extra = {}) => ({
  customerName: "عميل", customerPhone: "01000000000", sellingDate: "2026-11-05",
  items: [{ productId: String(product._id), quantity, price }], ...extra,
});

async function withFailingAudit(action) {
  const originalCreate = AuditLog.create;
  AuditLog.create = async () => { throw new Error("forced audit failure"); };
  try {
    return await action();
  } finally {
    AuditLog.create = originalCreate;
  }
}

it("cash create rolls back stock, invoice and counter when its audit write fails", async () => {
  const { product } = await catalog(2);
  const response = await withFailingAudit(() => call("POST", "/api/sellings", saleBody(product)));
  assert.equal(response.status, 500);
  assert.equal((await Product.findById(product._id)).inventoryCount, 2);
  assert.equal(await Selling.countDocuments(), 0);
  assert.equal(await Counter.countDocuments({ _id: "INV" }), 0);
});

it("credit create rolls back stock, invoice, customer and counter when its audit write fails", async () => {
  const { product } = await catalog(2);
  const response = await withFailingAudit(() => call("POST", "/api/credit-sales", saleBody(product)));
  assert.equal(response.status, 500);
  assert.equal((await Product.findById(product._id)).inventoryCount, 2);
  assert.equal(await CreditSale.countDocuments(), 0);
  assert.equal(await Customer.countDocuments({ phone: "01000000000" }), 0);
  assert.equal(await Counter.countDocuments({ _id: "CR" }), 0);
});

it("payment rolls back its invoice, receipt and RC counter when its audit write fails", async () => {
  const { product } = await catalog(2);
  const customer = await Customer.create({ name: "عميل دفعة", phone: "01000000001" });
  const invoice = await call("POST", "/api/credit-sales", saleBody(product, 1, 100, { customerId: String(customer._id), customerName: undefined, customerPhone: undefined }));
  const response = await withFailingAudit(() => call("POST", `/api/credit-sales/${invoice.json._id}/payments`, { amount: 25 }));
  assert.equal(response.status, 500);
  const unchanged = await CreditSale.findById(invoice.json._id).lean();
  assert.equal(unchanged.payments.length, 0);
  assert.equal(unchanged.remainingAmount, 100);
  assert.equal(await Receipt.countDocuments(), 0);
  assert.equal(await Counter.countDocuments({ _id: "RC" }), 0);
});

it("return rolls back stock, invoice, ReturnLog and RT counter when its audit write fails", async () => {
  const { product } = await catalog(2);
  const invoice = await call("POST", "/api/sellings", saleBody(product));
  const beforeStock = (await Product.findById(product._id)).inventoryCount;
  const response = await withFailingAudit(() => call("POST", "/api/returns", {
    returnType: "cash", invoiceId: invoice.json._id, items: [{ itemId: invoice.json.items[0]._id, quantity: 1 }],
  }));
  assert.equal(response.status, 500);
  const unchanged = await Selling.findById(invoice.json._id).lean();
  assert.equal(unchanged.refunds.length, 0);
  assert.equal((await Product.findById(product._id)).inventoryCount, beforeStock);
  assert.equal(await ReturnLog.countDocuments(), 0);
  assert.equal(await Counter.countDocuments({ _id: "RT" }), 0);
});

it("cancel rolls back stock and invoice state when its audit write fails", async () => {
  const { product } = await catalog(2);
  const invoice = await call("POST", "/api/sellings", saleBody(product));
  const beforeStock = (await Product.findById(product._id)).inventoryCount;
  const response = await withFailingAudit(() => call("POST", `/api/sellings/${invoice.json._id}/cancel`, { reason: "سبب اختباري" }));
  assert.equal(response.status, 500);
  assert.equal((await Selling.findById(invoice.json._id)).status, "active");
  assert.equal((await Product.findById(product._id)).inventoryCount, beforeStock);
});

it("numbers are transactional: an aborted sale leaves no gap", async () => {
  const { product } = await catalog(1);
  const failed = await call("POST", "/api/sellings", saleBody(product, 2));
  assert.equal(failed.status, 409);
  assert.equal(await Counter.countDocuments(), 0);
  const created = await call("POST", "/api/sellings", saleBody(product));
  assert.equal(created.status, 201);
  assert.equal(created.json.number, "INV-000001");
});

it("two concurrent sales of the final unit: one succeeds and stock never goes negative", async () => {
  const { product } = await catalog(1);
  const results = await Promise.all([
    call("POST", "/api/sellings", saleBody(product)),
    call("POST", "/api/sellings", saleBody(product)),
  ]);
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 1);
  assert.equal((await Product.findById(product._id)).inventoryCount, 0);
  assert.equal(await Selling.countDocuments(), 1);
});

it("a full cash return keeps the original invoice, gives it an RT number, and cannot be repeated", async () => {
  const { product } = await catalog(2);
  const created = await call("POST", "/api/sellings", saleBody(product, 2, 100));
  const returned = await call("POST", "/api/returns", {
    returnType: "cash", invoiceId: created.json._id,
    items: [{ itemId: created.json.items[0]._id, quantity: 2 }],
  });
  assert.equal(returned.status, 201);
  assert.equal(returned.json.data.returnLog.number, "RT-000001");
  const invoice = await Selling.findById(created.json._id).lean();
  assert.equal(invoice.totalPrice, 200);
  assert.equal(invoice.refundedAmount, 200);
  assert.equal(invoice.refundStatus, "full");
  assert.equal(await ReturnLog.countDocuments(), 1);
  const repeated = await call("POST", "/api/returns", {
    returnType: "cash", invoiceId: created.json._id,
    items: [{ itemId: created.json.items[0]._id, quantity: 1 }],
  });
  assert.equal(repeated.status, 409);
});

it("credit cancel with a down payment produces balancing statement lines", async () => {
  const { product } = await catalog(10);
  const customer = await Customer.create({ name: "عميل آجل", phone: "01111111111" });
  const created = await call("POST", "/api/credit-sales", saleBody(product, 1, 790, {
    customerId: String(customer._id), customerName: undefined, customerPhone: undefined, initialPaidAmount: 200,
  }));
  assert.equal(created.status, 201);
  assert.equal(created.json.number, "CR-000001");
  assert.equal(created.json.payments[0].number, "RC-000001");
  const cancelled = await call("POST", `/api/credit-sales/${created.json._id}/cancel`, { reason: "طلب العميل" });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.cancelRefundAmount, 200);
  const statement = await call("GET", `/api/customers/${customer._id}/statement`);
  assert.equal(statement.status, 200);
  assert.deepEqual(statement.json.lines.map((line) => [line.description, line.debit, line.credit]), [
    ["فاتورة آجل CR-000001", 790, 0],
    ["دفعة مقدمة", 0, 200],
    ["إلغاء فاتورة آجل", 0, 790],
    ["رد المقدم", 200, 0],
  ]);
  assert.equal(statement.json.totals.balance, 0);
});

it("a normal payment blocks credit cancellation", async () => {
  const { product } = await catalog(2);
  const customer = await Customer.create({ name: "عميل آجل", phone: "01222222222" });
  const created = await call("POST", "/api/credit-sales", saleBody(product, 1, 100, {
    customerId: String(customer._id), customerName: undefined, customerPhone: undefined,
  }));
  await call("POST", `/api/credit-sales/${created.json._id}/payments`, { amount: 10 });
  const cancelled = await call("POST", `/api/credit-sales/${created.json._id}/cancel`, { reason: "طلب العميل" });
  assert.equal(cancelled.status, 409);
  assert.equal(cancelled.json.code, "HAS_PAYMENTS");
});

it("both payment routes return their original 400 body without writing inside the transaction callback", async () => {
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loggedErrors.push(args.map(String).join(" "));
  try {
  const { product } = await catalog(2);
  const customer = await Customer.create({ name: "عميل حد الدفعة", phone: "01222222223" });
  const created = await call("POST", "/api/credit-sales", saleBody(product, 1, 100, {
    customerId: String(customer._id), customerName: undefined, customerPhone: undefined,
  }));
  const direct = await call("POST", `/api/credit-sales/${created.json._id}/payments`, { amount: 101 });
  assert.equal(direct.status, 400);
  assert.equal(direct.json.message, "قيمة الدفعة لا يمكن أن تتجاوز إجمالي المبلغ المتبقي على كل الفواتير المفتوحة");
  assert.equal(direct.json.remainingAmount, 100);
  const customerRoute = await call("POST", `/api/customers/${customer._id}/payments`, { amount: 101, lastInvoice: true });
  assert.equal(customerRoute.status, 400);
  assert.equal(customerRoute.json.message, "قيمة الدفعة لا يمكن أن تتجاوز إجمالي المبلغ المتبقي على كل الفواتير المفتوحة");
  assert.equal(customerRoute.json.remainingAmount, 100);
  assert.equal((await CreditSale.findById(created.json._id)).payments.length, 0);
  assert.equal(await Receipt.countDocuments(), 0);
  } finally {
    console.error = originalConsoleError;
  }
  assert.doesNotMatch(loggedErrors.join("\n"), /TypeError/);
});

it("credit returns preserve original lines and totals and reallocate overpayment atomically", async () => {
  const { product } = await catalog(5);
  const customer = await Customer.create({ name: "عميل آجل", phone: "01333333333" });
  const source = await call("POST", "/api/credit-sales", saleBody(product, 2, 100, {
    customerId: String(customer._id), customerName: undefined, customerPhone: undefined,
  }));
  const target = await call("POST", "/api/credit-sales", saleBody(product, 1, 100, {
    customerId: String(customer._id), customerName: undefined, customerPhone: undefined,
  }));
  await call("POST", `/api/credit-sales/${source.json._id}/payments`, { amount: 150 });
  const returned = await call("POST", "/api/returns", {
    returnType: "credit", invoiceId: source.json._id,
    items: [{ itemId: source.json.items[0]._id, quantity: 1 }],
  });
  assert.equal(returned.status, 201);
  assert.equal(returned.json.number, "CR-000001");
  assert.equal(returned.json.totalPrice, 200);
  assert.equal(returned.json.netTotal, 100);
  assert.equal(returned.json.items[0].productQuantity, 2);
  assert.equal(returned.json.items[0].returnedQuantity, 1);
  assert.equal(returned.json.refundedAmount, 100);
  assert.equal(returned.json.reallocatedPaidAmount, 50);
  assert.equal((await CreditSale.findById(target.json._id)).remainingAmount, 50);
  assert.equal((await ReturnLog.findOne({ invoiceId: source.json._id })).number, "RT-000001");
});

it("referenced products archive, non-empty categories and invoiced customers cannot be deleted", async () => {
  const { category, product } = await catalog(2);
  const customer = await Customer.create({ name: "عميل آجل", phone: "01555555555" });
  await call("POST", "/api/credit-sales", saleBody(product, 1, 100, {
    customerId: String(customer._id), customerName: undefined, customerPhone: undefined,
  }));
  const productDelete = await call("DELETE", `/api/products/${product._id}`);
  assert.equal(productDelete.status, 200);
  assert.equal(productDelete.json.action, "archived");
  const categoryDelete = await call("DELETE", `/api/categories/${category._id}`);
  assert.equal(categoryDelete.status, 409);
  assert.equal(categoryDelete.json.code, "CATEGORY_NOT_EMPTY");
  const customerDelete = await call("DELETE", `/api/customers/${customer._id}`);
  assert.equal(customerDelete.status, 409);
  assert.equal(customerDelete.json.code, "CUSTOMER_HAS_INVOICES");
});

it("original-total migration restores removed credit lines, estimates missing cost, and is idempotent", async () => {
  const { product } = await catalog(10);
  const customer = await Customer.create({ name: "ترحيل", phone: "01444444444" });
  const invoiceId = new (require("mongoose").Types.ObjectId)();
  const itemId = new (require("mongoose").Types.ObjectId)();
  const returnLogId = new (require("mongoose").Types.ObjectId)();
  await ReturnLog.collection.insertOne({
    _id: returnLogId, returnType: "credit", invoiceId, customerName: "ترحيل", customerPhone: customer.phone,
    returnDate: new Date("2025-01-02"), items: [{ productId: product._id, productName: product.name, productCode: product.code, quantity: 1, price: 100, total: 100 }],
    subtotalReturnedAmount: 100, discountAmount: 0, shippingFees: 0, finalReturnedAmount: 100,
    createdAt: new Date("2025-01-02"), updatedAt: new Date("2025-01-02"),
  });
  await CreditSale.collection.insertOne({
    _id: invoiceId, customer: customer._id, customerName: customer.name, customerPhone: customer.phone,
    sellingDate: new Date("2025-01-01"), items: [], totalQuantity: 0, discountAmount: 0, shippingFees: 0,
    totalPrice: 0, paidAmount: 0, remainingAmount: 0, refundDueAmount: 0, status: "Reactionary",
    refundStatus: "full", refundedQuantity: 1, refundedAmount: 100, returnedPaidAmount: 0, reallocatedPaidAmount: 0,
    refunds: [{ refundDate: new Date("2025-01-02"), items: [{ invoiceItemId: itemId, product: product._id, productName: product.name, quantity: 1, unitPrice: 100, totalPrice: 100 }], totalQuantity: 1, totalAmount: 100, returnLog: returnLogId }],
    payments: [], createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-02"),
  });

  assert.equal(await runMigrations(), 4);
  const migrated = await CreditSale.findById(invoiceId).lean();
  assert.equal(migrated.number, "CR-000001");
  assert.equal(migrated.status, "returned");
  assert.equal(migrated.totalPrice, 100);
  assert.equal(migrated.refundedAmount, 100);
  assert.equal(migrated.items[0].quantity, 1);
  assert.equal(migrated.items[0].returnedQuantity, 1);
  assert.equal(migrated.items[0].purchasePrice, product.purchasePrice);
  assert.equal(migrated.items[0].costEstimated, true);
  assert.deepEqual(migrated.migrationNotes, [`cost estimated for ${product.name}`]);
  const migrationAudit = await AuditLog.findOne({ action: "system.migration", "details.version": 2 }).lean();
  assert.deepEqual(migrationAudit.details.estimatedCostInvoices, [String(invoiceId)]);
  const auditCount = await AuditLog.countDocuments({ action: "system.migration" });
  assert.equal(await runMigrations(), 4);
  assert.equal(await AuditLog.countDocuments({ action: "system.migration" }), auditCount);
  assert.equal((await Meta.findById("schema")).version, 4);
});

it("original-total migration preserves historical cost on a fully removed credit line", async () => {
  const { product } = await catalog(10);
  const customer = await Customer.create({ name: "تكلفة تاريخية", phone: "01777777777" });
  const invoiceId = new (require("mongoose").Types.ObjectId)();
  const itemId = new (require("mongoose").Types.ObjectId)();
  const returnLogId = new (require("mongoose").Types.ObjectId)();
  await ReturnLog.collection.insertOne({
    _id: returnLogId, returnType: "credit", invoiceId, customerName: customer.name, customerPhone: customer.phone,
    returnDate: new Date("2025-01-02"), items: [{ productId: product._id, productName: product.name, productCode: product.code,
      quantity: 1, price: 100, total: 100, purchasePrice: 35, profitAmount: 65 }],
    subtotalReturnedAmount: 100, discountAmount: 0, shippingFees: 0, finalReturnedAmount: 100,
    createdAt: new Date("2025-01-02"), updatedAt: new Date("2025-01-02"),
  });
  await CreditSale.collection.insertOne({
    _id: invoiceId, customer: customer._id, customerName: customer.name, customerPhone: customer.phone,
    sellingDate: new Date("2025-01-01"), items: [], totalQuantity: 0, discountAmount: 0, shippingFees: 0,
    totalPrice: 0, paidAmount: 0, remainingAmount: 0, refundDueAmount: 0, status: "Reactionary",
    refundStatus: "full", refundedQuantity: 1, refundedAmount: 100, returnedPaidAmount: 0, reallocatedPaidAmount: 0,
    refunds: [{ refundDate: new Date("2025-01-02"), items: [{ invoiceItemId: itemId, product: product._id,
      productName: product.name, quantity: 1, unitPrice: 100, totalPrice: 100, purchasePrice: 35, profitAmount: 65 }],
      totalQuantity: 1, totalAmount: 100, returnLog: returnLogId }],
    payments: [], createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-02"),
  });

  await runMigrations();
  const migrated = await CreditSale.findById(invoiceId).lean();
  assert.equal(migrated.items[0].purchasePrice, 35);
  assert.equal(migrated.items[0].profitAmount, 65);
  assert.equal(migrated.items[0].costEstimated, false);
  assert.deepEqual(migrated.migrationNotes || [], []);
  const migrationAudit = await AuditLog.findOne({ action: "system.migration", "details.version": 2 }).lean();
  assert.deepEqual(migrationAudit.details.estimatedCostInvoices, []);
});

it("original-total migration skips an invoice already marked as restored", async () => {
  const customer = await Customer.create({ name: "ترحيل مكتمل", phone: "01777777778" });
  const invoiceId = new (require("mongoose").Types.ObjectId)();
  await CreditSale.collection.insertOne({
    _id: invoiceId, customer: customer._id, customerName: customer.name, customerPhone: customer.phone,
    sellingDate: new Date("2025-02-01"), items: [], totalQuantity: 0, totalPrice: 100, paidAmount: 0,
    remainingAmount: 100, status: "pending", stage16OriginalTotalsRestored: true,
    refunds: [{ returnLog: new (require("mongoose").Types.ObjectId)(), refundDate: new Date("2025-02-02"),
      items: [], totalQuantity: 1, totalAmount: 50 }], createdAt: new Date("2025-02-01"), updatedAt: new Date("2025-02-02"),
  });
  await runMigrations();
  const invoice = await CreditSale.findById(invoiceId).lean();
  assert.equal(invoice.totalPrice, 100);
  assert.equal(invoice.stage16OriginalTotalsRestored, true);
});

it("migration restores cash returnedQuantity so profit reports use the remaining quantity", async () => {
  const { product } = await catalog(10);
  const invoiceId = new (require("mongoose").Types.ObjectId)();
  const itemId = new (require("mongoose").Types.ObjectId)();
  const returnLogId = new (require("mongoose").Types.ObjectId)();
  await Selling.collection.insertOne({
    _id: invoiceId, customerName: "عميل كاش قديم", customerPhone: "01012345000", sellingDate: new Date("2025-03-01"),
    items: [{ _id: itemId, product: product._id, productName: product.name, quantity: 3, unitPrice: 100,
      totalPrice: 300, purchasePrice: 20, profitAmount: 240 }], totalQuantity: 3, discountAmount: 0,
    shippingFees: 0, totalPrice: 300, refundStatus: "partial", refundedQuantity: 1, refundedAmount: 100,
    refunds: [{ refundDate: new Date("2025-03-02"), returnLog: returnLogId, totalQuantity: 1, totalAmount: 100,
      items: [{ invoiceItemId: itemId, product: product._id, productName: product.name, quantity: 1, unitPrice: 100, totalPrice: 100 }] }],
    createdAt: new Date("2025-03-01"), updatedAt: new Date("2025-03-02"),
  });
  await ReturnLog.collection.insertOne({
    _id: returnLogId, returnType: "cash", invoiceId, customerName: "عميل كاش قديم", returnDate: new Date("2025-03-02"),
    items: [{ productId: product._id, productName: product.name, quantity: 1, price: 100, total: 100 }],
    subtotalReturnedAmount: 100, discountAmount: 0, shippingFees: 0, finalReturnedAmount: 100,
    createdAt: new Date("2025-03-02"), updatedAt: new Date("2025-03-02"),
  });
  await runMigrations();
  assert.equal((await Selling.findById(invoiceId)).items[0].returnedQuantity, 1);
  const report = await call("GET", `/api/products/${product._id}/profit-report`);
  assert.equal(report.status, 200);
  const migratedInvoice = report.json[0].invoices.find((invoice) => String(invoice.invoiceId) === String(invoiceId));
  assert.equal(migratedInvoice.quantity, 2);
  assert.equal(migratedInvoice.revenue, 200);
  assert.equal(migratedInvoice.profit, 160);
});

it("migration uses final credit-return amounts and merges old partial-return lines", async () => {
  const { product } = await catalog(10);
  const customer = await Customer.create({ name: "عميل ترحيل خصم", phone: "01012345001" });
  const fullId = new (require("mongoose").Types.ObjectId)();
  const fullItemId = new (require("mongoose").Types.ObjectId)();
  const fullLogId = new (require("mongoose").Types.ObjectId)();
  await ReturnLog.collection.insertOne({
    _id: fullLogId, returnType: "credit", invoiceId: fullId, customerName: customer.name, customerPhone: customer.phone,
    returnDate: new Date("2025-04-02"), items: [{ productId: product._id, productName: product.name, quantity: 3, price: 100, total: 300, purchasePrice: 20 }],
    subtotalReturnedAmount: 300, discountAmount: 10, shippingFees: 5, finalReturnedAmount: 295,
    createdAt: new Date("2025-04-02"), updatedAt: new Date("2025-04-02"),
  });
  await CreditSale.collection.insertOne({
    _id: fullId, customer: customer._id, customerName: customer.name, customerPhone: customer.phone,
    sellingDate: new Date("2025-04-01"), items: [], totalQuantity: 0, discountAmount: 10, shippingFees: 0, totalPrice: 0,
    paidAmount: 0, remainingAmount: 0, refundDueAmount: 0, status: "Reactionary", refundStatus: "full",
    refundedQuantity: 3, refundedAmount: 300, returnedPaidAmount: 0, reallocatedPaidAmount: 0, payments: [],
    refunds: [{ refundDate: new Date("2025-04-02"), returnLog: fullLogId, totalQuantity: 3, totalAmount: 300,
      items: [{ invoiceItemId: fullItemId, product: product._id, productName: product.name, quantity: 3, unitPrice: 100, totalPrice: 300, purchasePrice: 20 }] }],
    createdAt: new Date("2025-04-01"), updatedAt: new Date("2025-04-02"),
  });

  const partialId = new (require("mongoose").Types.ObjectId)();
  const remainingItemId = new (require("mongoose").Types.ObjectId)();
  const oldItemId = new (require("mongoose").Types.ObjectId)();
  const partialLogId = new (require("mongoose").Types.ObjectId)();
  await ReturnLog.collection.insertOne({
    _id: partialLogId, returnType: "credit", invoiceId: partialId, customerName: customer.name, customerPhone: customer.phone,
    returnDate: new Date("2025-05-02"), items: [{ productId: product._id, productName: product.name, quantity: 1, price: 100, total: 100 }],
    subtotalReturnedAmount: 100, discountAmount: 0, shippingFees: 0, finalReturnedAmount: 100,
    createdAt: new Date("2025-05-02"), updatedAt: new Date("2025-05-02"),
  });
  await CreditSale.collection.insertOne({
    _id: partialId, customer: customer._id, customerName: customer.name, customerPhone: customer.phone,
    sellingDate: new Date("2025-05-01"), items: [{ _id: remainingItemId, product: product._id, productName: product.name,
      quantity: 2, unitPrice: 100, totalPrice: 200, purchasePrice: 20, profitAmount: 160 }], totalQuantity: 2,
    discountAmount: 0, shippingFees: 0, totalPrice: 200, paidAmount: 0, remainingAmount: 200, refundDueAmount: 0,
    status: "pending", refundStatus: "partial", refundedQuantity: 1, refundedAmount: 100, returnedPaidAmount: 0,
    reallocatedPaidAmount: 0, payments: [], refunds: [{ refundDate: new Date("2025-05-02"), returnLog: partialLogId,
      totalQuantity: 1, totalAmount: 100, items: [{ invoiceItemId: oldItemId, product: product._id, productName: product.name,
        quantity: 1, unitPrice: 100, totalPrice: 100 }] }], createdAt: new Date("2025-05-01"), updatedAt: new Date("2025-05-02"),
  });

  await runMigrations();
  const full = await CreditSale.findById(fullId).lean();
  assert.equal(full.refunds[0].totalAmount, 295);
  const statement = await call("GET", `/api/customers/${customer._id}/statement`);
  assert.equal(statement.status, 200);
  assert.equal(statement.json.totals.balance, 200);
  const fullReturnLine = statement.json.lines.find((line) => line.type === "return" && line.number === "RT-000001");
  assert.equal(fullReturnLine.credit, 295);
  const partial = await CreditSale.findById(partialId).lean();
  assert.equal(partial.items.length, 1);
  assert.equal(partial.items[0].quantity, 3);
  assert.equal(partial.items[0].returnedQuantity, 1);
  assert.equal(partial.items[0].purchasePrice, 20);
  assert.equal(partial.items[0].costEstimated, false);
  assert.equal(partial.stage16OriginalTotalsRestored, true);
});

it("number migration skips old return reallocations and recognizes old down payments", async () => {
  const { product } = await catalog(10);
  const customer = await Customer.create({ name: "عميل دفعات قديمة", phone: "01012345002" });
  const sourceId = new (require("mongoose").Types.ObjectId)();
  const targetId = new (require("mongoose").Types.ObjectId)();
  const downId = new (require("mongoose").Types.ObjectId)();
  const createdAt = new Date();
  const baseInvoice = { customer: customer._id, customerName: customer.name, customerPhone: customer.phone,
    items: [{ product: product._id, productName: product.name, quantity: 1, unitPrice: 100, totalPrice: 100, purchasePrice: 20, profitAmount: 80 }],
    totalQuantity: 1, discountAmount: 0, shippingFees: 0, totalPrice: 100, refundStatus: "none", refundedQuantity: 0,
    refundedAmount: 0, returnedPaidAmount: 0, refunds: [], createdAt, updatedAt: createdAt };
  await CreditSale.collection.insertMany([
    { ...baseInvoice, _id: sourceId, sellingDate: createdAt, paidAmount: 0, remainingAmount: 100, refundDueAmount: 0,
      status: "pending", reallocatedPaidAmount: 50, payments: [] },
    { ...baseInvoice, _id: targetId, sellingDate: createdAt, paidAmount: 50, remainingAmount: 50, refundDueAmount: 0,
      status: "partially_paid", reallocatedPaidAmount: 0, payments: [{ _id: new (require("mongoose").Types.ObjectId)(), amount: 50,
        paymentDate: createdAt, note: `تسوية تلقائية من مرتجع الفاتورة ${sourceId}` }] },
    { ...baseInvoice, _id: downId, sellingDate: createdAt, paidAmount: 20, remainingAmount: 80, refundDueAmount: 0,
      status: "partially_paid", reallocatedPaidAmount: 0, payments: [{ _id: new (require("mongoose").Types.ObjectId)(), amount: 20, paymentDate: createdAt }] },
  ]);
  await runMigrations();
  const target = await CreditSale.findById(targetId).lean();
  assert.equal(target.payments[0].source, "return_reallocation");
  assert.equal(target.payments[0].number, undefined);
  const down = await CreditSale.findById(downId).lean();
  assert.equal(down.payments[0].source, "down_payment");
  assert.equal((await Receipt.findById(down.payments[0].receipt)).kind, "down_payment");
  assert.equal(await Receipt.countDocuments(), 1);
  const cancelled = await call("POST", `/api/credit-sales/${downId}/cancel`, { reason: "طلب العميل" });
  assert.equal(cancelled.status, 200);
});

it("category import database write failures abort every inserted row", async () => {
  const categoryId = new (require("mongoose").Types.ObjectId)();
  const productId = new (require("mongoose").Types.ObjectId)();
  const workbook = createCategoryWorkbook(
    [{ _id: categoryId, name: "فئة استيراد", image: "", specifications: [] }],
    [{ productId: String(productId), categoryId: String(categoryId), categoryName: "فئة استيراد", name: "صنف استيراد",
      code: "IMP-1", inventoryCount: 2, imageBase64: "", wholesalePrice: 30, purchasePrice: 20, retailPrice: 40,
      soldItemCount: 0, specifications: [] }]
  );
  const originalInsertMany = Product.insertMany;
  Product.insertMany = async () => { const error = new Error("forced product insert failure"); error.code = 11000; throw error; };
  try {
    await assert.rejects(
      withTransaction((session) => importCategories(workbook, session)),
      (error) => error.statusCode === 400 && error.responseData?.code === "CATEGORY_IMPORT_FAILED"
    );
  } finally {
    Product.insertMany = originalInsertMany;
  }
  assert.equal(await Category.countDocuments({ name: "فئة استيراد" }), 0);
  assert.equal(await Product.countDocuments({ code: "IMP-1" }), 0);
});

it("batched migration numbers about 5,000 legacy documents well inside the raised limit", async (t) => {
  const mongoose = require("mongoose");
  const customerId = new mongoose.Types.ObjectId();
  const now = new Date("2025-06-01");
  const cash = Array.from({ length: 2000 }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(), customerName: `C${index}`, sellingDate: now, totalPrice: 1,
    items: [], refunds: [], createdAt: now, updatedAt: now,
  }));
  const credit = Array.from({ length: 1500 }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(), customer: customerId, customerName: `D${index}`, customerPhone: "01099999999",
    sellingDate: now, items: [], totalQuantity: 0, totalPrice: 1, paidAmount: 1, remainingAmount: 0,
    status: "paid", refunds: [], payments: [{ _id: new mongoose.Types.ObjectId(), amount: 1,
      paymentDate: new Date(now.getTime() + 86400000), note: "دفعة" }], createdAt: now, updatedAt: now,
  }));
  const returns = Array.from({ length: 1500 }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(), returnType: "cash", invoiceId: cash[index]._id, customerName: `C${index}`,
    returnDate: now, items: [{ productId: new mongoose.Types.ObjectId(), productName: "x", quantity: 1, price: 1, total: 1 }],
    subtotalReturnedAmount: 1, finalReturnedAmount: 1, createdAt: now, updatedAt: now,
  }));
  await Selling.collection.insertMany(cash);
  await CreditSale.collection.insertMany(credit);
  await ReturnLog.collection.insertMany(returns);
  const started = Date.now();
  await runMigrations();
  const elapsed = Date.now() - started;
  t.diagnostic(`5,000-document Stage 16 migration: ${elapsed} ms`);
  assert.ok(elapsed < 120000, `migration took ${elapsed} ms`);
  assert.equal(await Selling.countDocuments({ number: /^INV-/ }), 2000);
  assert.equal(await CreditSale.countDocuments({ number: /^CR-/ }), 1500);
  assert.equal(await ReturnLog.countDocuments({ number: /^RT-/ }), 1500);
  assert.equal(await Receipt.countDocuments(), 1500);
});

it("a pre-Stage-16 restore fixture with a missing ReturnLog fails the migration atomically and names the invoice", async () => {
  const { product } = await catalog(10);
  const customer = await Customer.create({ name: "نسخة تالفة", phone: "01666666666" });
  const invoiceId = new (require("mongoose").Types.ObjectId)();
  const missingLogId = new (require("mongoose").Types.ObjectId)();
  const itemId = new (require("mongoose").Types.ObjectId)();
  await CreditSale.collection.insertOne({
    _id: invoiceId, number: "CR-FIXTURE", customer: customer._id,
    customerName: customer.name, customerPhone: customer.phone,
    sellingDate: new Date("2025-02-01"),
    items: [{ _id: itemId, product: product._id, productName: product.name, productCode: product.code,
      quantity: 1, unitPrice: 100, totalPrice: 100, purchasePrice: 20, profitAmount: 80 }],
    totalQuantity: 1, discountAmount: 0, shippingFees: 0, totalPrice: 0,
    paidAmount: 0, remainingAmount: 0, refundDueAmount: 0, status: "Reactionary",
    refundStatus: "full", refundedQuantity: 1, refundedAmount: 100,
    returnedPaidAmount: 0, reallocatedPaidAmount: 0, payments: [],
    refunds: [{ refundDate: new Date("2025-02-02"), returnLog: missingLogId,
      items: [{ invoiceItemId: itemId, product: product._id, productName: product.name,
        quantity: 1, unitPrice: 100, totalPrice: 100 }], totalQuantity: 1, totalAmount: 100 }],
    createdAt: new Date("2025-02-01"), updatedAt: new Date("2025-02-02"),
  });

  await assert.rejects(runMigrations(), (error) => {
    assert.equal(error.code, "MIGRATION_ORIGINAL_TOTAL_FAILED");
    assert.match(error.message, /CR-FIXTURE/);
    return true;
  });
  const unchanged = await CreditSale.collection.findOne({ _id: invoiceId });
  assert.equal(unchanged.totalPrice, 0);
  assert.equal(unchanged.status, "Reactionary");
  assert.equal(unchanged.items[0].quantity, 1);
  assert.equal((await Meta.findById("schema")).version, 1, "only the earlier number migration may be committed");
  assert.equal(await AuditLog.countDocuments({ action: "system.migration", "details.version": 2 }), 0);
});
