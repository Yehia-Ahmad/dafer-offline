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

it("customer payment formats every updated invoice without passing the array index as options", async () => {
  const { product } = await catalog(3);
  const customer = await Customer.create({ name: "formatted payment", phone: "01222222224" });
  const created = await call("POST", "/api/credit-sales", saleBody(product, 1, 100, {
    customerId: String(customer._id), customerName: undefined, customerPhone: undefined,
  }));
  assert.equal(created.status, 201);
  const paid = await call("POST", `/api/customers/${customer._id}/payments`, { amount: 25, lastInvoice: true });
  assert.equal(paid.status, 201);
  assert.equal(paid.json.invoices.length, 1);
  assert.equal(paid.json.invoices[0].invoiceId, created.json.invoiceId);
  assert.equal(paid.json.invoices[0].paidAmount, 25);
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

  assert.equal(await runMigrations(), 7);
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
  assert.equal(await runMigrations(), 7);
  assert.equal(await AuditLog.countDocuments({ action: "system.migration" }), auditCount);
  assert.equal((await Meta.findById("schema")).version, 7);
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

it("migration flags a removed-line cost inferred only from legacy return profit", async () => {
  const { product } = await catalog(10);
  const customer = await Customer.create({ name: "legacy return cost", phone: "01777777779" });
  const mongoose = require("mongoose");
  const invoiceId = new mongoose.Types.ObjectId();
  const itemId = new mongoose.Types.ObjectId();
  const returnLogId = new mongoose.Types.ObjectId();
  const returned = { productId: product._id, product: product._id, productName: product.name,
    quantity: 1, price: 100, unitPrice: 100, total: 100, totalPrice: 100, profitAmount: 60 };
  await ReturnLog.collection.insertOne({
    _id: returnLogId, returnType: "credit", invoiceId, customerName: customer.name, customerPhone: customer.phone,
    returnDate: new Date("2025-01-02"), items: [returned], subtotalReturnedAmount: 100,
    discountAmount: 0, shippingFees: 0, finalReturnedAmount: 100,
    createdAt: new Date("2025-01-02"), updatedAt: new Date("2025-01-02"),
  });
  await CreditSale.collection.insertOne({
    _id: invoiceId, customer: customer._id, customerName: customer.name, customerPhone: customer.phone,
    sellingDate: new Date("2025-01-01"), items: [], totalQuantity: 0, discountAmount: 0, shippingFees: 0,
    totalPrice: 0, paidAmount: 0, remainingAmount: 0, refundDueAmount: 0, status: "Reactionary",
    refundStatus: "full", refundedQuantity: 1, refundedAmount: 100, returnedPaidAmount: 0,
    reallocatedPaidAmount: 0, payments: [], refunds: [{ refundDate: new Date("2025-01-02"),
      returnLog: returnLogId, totalQuantity: 1, totalAmount: 100,
      items: [{ ...returned, invoiceItemId: itemId }] }],
    createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-02"),
  });

  await runMigrations();
  const migrated = await CreditSale.findById(invoiceId).lean();
  assert.equal(migrated.items[0].purchasePrice, 40);
  assert.equal(migrated.items[0].costEstimated, true);
  assert.deepEqual(migrated.migrationNotes, [`cost estimated for ${product.name}`]);
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

it("migration converts a returned legacy single-product cash sale before restoring totals", async () => {
  const { product } = await catalog(10);
  const mongoose = require("mongoose");
  const invoiceId = new mongoose.Types.ObjectId();
  const oldItemId = new mongoose.Types.ObjectId();
  const returnLogId = new mongoose.Types.ObjectId();
  await Selling.collection.insertOne({
    _id: invoiceId, customerName: "legacy cash", sellingDate: new Date("2025-03-01"),
    product: product._id, productName: product.name, productCode: product.code, categoryName: "legacy",
    quantity: 3, unitPrice: 100, profitAmount: 240, totalPrice: 300,
    refunds: [{ refundDate: new Date("2025-03-02"), returnLog: returnLogId, totalQuantity: 1, totalAmount: 100,
      items: [{ invoiceItemId: oldItemId, product: product._id, productName: product.name, quantity: 1, unitPrice: 100, totalPrice: 100 }] }],
    refundStatus: "partial", refundedQuantity: 1, refundedAmount: 100,
    createdAt: new Date("2025-03-01"), updatedAt: new Date("2025-03-02"),
  });
  await ReturnLog.collection.insertOne({
    _id: returnLogId, returnType: "cash", invoiceId, customerName: "legacy cash", returnDate: new Date("2025-03-02"),
    items: [{ productId: product._id, productName: product.name, quantity: 1, price: 100, total: 100 }],
    subtotalReturnedAmount: 100, discountAmount: 0, shippingFees: 0, finalReturnedAmount: 100,
    createdAt: new Date("2025-03-02"), updatedAt: new Date("2025-03-02"),
  });

  await runMigrations();
  const migrated = await Selling.collection.findOne({ _id: invoiceId });
  assert.equal(migrated.items.length, 1);
  assert.equal(String(migrated.items[0]._id), String(invoiceId));
  assert.equal(migrated.items[0].quantity, 3);
  assert.equal(migrated.items[0].returnedQuantity, 1);
  assert.equal(migrated.items[0].purchasePrice, product.purchasePrice);
  assert.ok(product.purchasePrice > 0);
  assert.notEqual(migrated.items[0].profitAmount, migrated.items[0].totalPrice, "profit must not equal revenue");
  assert.equal(migrated.items[0].costEstimated, true);
  for (const field of ["product", "productName", "productCode", "categoryName", "quantity", "unitPrice", "purchasePrice", "profitAmount"]) {
    assert.equal(migrated[field], undefined, `${field} should be removed from the invoice root`);
  }
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
  assert.equal(partial.items[0].costEstimated, true);
  assert.match(partial.migrationNotes.join("|"), /merged/);
  assert.equal(partial.stage16OriginalTotalsRestored, true);
});

it("migration combines two legacy partial returns into the one current invoice line", async () => {
  const { product } = await catalog(10);
  const customer = await Customer.create({ name: "two returns", phone: "01012345999" });
  const mongoose = require("mongoose");
  const invoiceId = new mongoose.Types.ObjectId();
  const currentItemId = new mongoose.Types.ObjectId();
  const oldItemIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const logIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  await ReturnLog.collection.insertMany(logIds.map((logId, index) => ({
    _id: logId, returnType: "credit", invoiceId, customerName: customer.name, customerPhone: customer.phone,
    returnDate: new Date(`2025-05-0${index + 2}`),
    items: [{ productId: product._id, productName: product.name, quantity: 1, price: 100, total: 100 }],
    subtotalReturnedAmount: 100, discountAmount: 0, shippingFees: 0, finalReturnedAmount: 100,
    createdAt: new Date(`2025-05-0${index + 2}`), updatedAt: new Date(`2025-05-0${index + 2}`),
  })));
  await CreditSale.collection.insertOne({
    _id: invoiceId, customer: customer._id, customerName: customer.name, customerPhone: customer.phone,
    sellingDate: new Date("2025-05-01"), items: [{ _id: currentItemId, product: product._id, productName: product.name,
      quantity: 1, unitPrice: 100, totalPrice: 100, purchasePrice: 20, profitAmount: 80 }], totalQuantity: 1,
    discountAmount: 0, shippingFees: 0, totalPrice: 100, paidAmount: 0, remainingAmount: 100, refundDueAmount: 0,
    status: "pending", refundStatus: "partial", refundedQuantity: 2, refundedAmount: 200,
    returnedPaidAmount: 0, reallocatedPaidAmount: 0, payments: [],
    refunds: logIds.map((logId, index) => ({ refundDate: new Date(`2025-05-0${index + 2}`), returnLog: logId,
      totalQuantity: 1, totalAmount: 100, items: [{ invoiceItemId: oldItemIds[index], product: product._id,
        productName: product.name, quantity: 1, unitPrice: 100, totalPrice: 100 }] })),
    createdAt: new Date("2025-05-01"), updatedAt: new Date("2025-05-03"),
  });

  await runMigrations();
  const migrated = await CreditSale.findById(invoiceId).lean();
  assert.equal(migrated.items.length, 1);
  assert.equal(migrated.items[0].quantity, 3);
  assert.equal(migrated.items[0].returnedQuantity, 2);
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

it("category import preserves TransientTransactionError for withTransaction retry", async () => {
  const categoryId = new (require("mongoose").Types.ObjectId)();
  const workbook = createCategoryWorkbook(
    [{ _id: categoryId, name: "transient import", image: "", specifications: [] }],
    []
  );
  const transient = new Error("retry this transaction");
  transient.hasErrorLabel = (label) => label === "TransientTransactionError";
  const originalInsertMany = Category.insertMany;
  Category.insertMany = async () => { throw transient; };
  try {
    await assert.rejects(importCategories(workbook, null), (error) => error === transient);
  } finally {
    Category.insertMany = originalInsertMany;
  }
});

it("batched migration numbers about 5,000 legacy documents under the default transaction limit", async (t) => {
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
  // Stage 17: the ledger opening entry refuses credit sales whose customer is missing.
  await mongoose.connection.collection("customers").insertOne({ _id: customerId, name: "Batch customer", phone: "01099999999", createdAt: now, updatedAt: now });
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

it("original-total migration resumes after a committed first chunk and matches a clean run", async () => {
  const mongoose = require("mongoose");
  const now = new Date("2025-07-01");
  const productId = new mongoose.Types.ObjectId();
  const fixtures = Array.from({ length: 501 }, (_, index) => {
    const invoiceId = new mongoose.Types.ObjectId();
    const itemId = new mongoose.Types.ObjectId();
    const returnLogId = new mongoose.Types.ObjectId();
    return {
      sale: {
        _id: invoiceId, number: `INV-R-${index}`, customerName: `resume ${index}`, sellingDate: now,
        items: [{ _id: itemId, product: productId, productName: "resume product", quantity: 2,
          unitPrice: 10, totalPrice: 20, purchasePrice: 3, profitAmount: 14 }], totalQuantity: 2,
        totalPrice: 20, refunds: [{ refundDate: now, returnLog: returnLogId, totalQuantity: 1, totalAmount: 10,
          items: [{ invoiceItemId: itemId, product: productId, productName: "resume product",
            quantity: 1, unitPrice: 10, totalPrice: 10 }] }], refundStatus: "partial",
        refundedQuantity: 1, refundedAmount: 10, createdAt: now, updatedAt: now,
      },
      log: {
        _id: returnLogId, number: `RT-R-${index}`, returnType: "cash", invoiceId,
        customerName: `resume ${index}`, returnDate: now,
        items: [{ productId, productName: "resume product", quantity: 1, price: 10, total: 10 }],
        subtotalReturnedAmount: 10, discountAmount: 0, shippingFees: 0, finalReturnedAmount: 10,
        createdAt: now, updatedAt: now,
      },
    };
  });
  const seed = async () => {
    await Meta.create({ _id: "schema", version: 1 });
    await Selling.collection.insertMany(fixtures.map(({ sale }) => sale));
    await ReturnLog.collection.insertMany(fixtures.map(({ log }) => log));
  };
  const snapshot = async () => Selling.collection.find({}, {
    projection: { _id: 1, refundedAmount: 1, stage16OriginalTotalsRestored: 1, "items.returnedQuantity": 1 },
  }).sort({ _id: 1 }).toArray();

  await seed();
  let stage16Chunks = 0;
  await assert.rejects(
    runMigrations({ afterChunk: ({ migration }) => {
      if (migration.version === 2 && ++stage16Chunks === 1) throw new Error("simulated migration crash");
    } }),
    /simulated migration crash/
  );
  const interruptedMeta = await Meta.findById("schema").lean();
  assert.equal(interruptedMeta.version, 1);
  assert.equal(interruptedMeta.migrationProgress.migration, 2);
  assert.equal(interruptedMeta.migrationProgress.phase, "cash");
  assert.equal(await Selling.countDocuments({ stage16OriginalTotalsRestored: true }), 500);

  await runMigrations();
  const resumed = await snapshot();
  assert.equal((await Meta.findById("schema")).version, 7);
  assert.equal((await Meta.findById("schema")).migrationProgress, undefined);

  await clearDatabase();
  await seed();
  await runMigrations();
  const clean = await snapshot();
  assert.deepEqual(resumed, clean);
});

it("desktop startup kills a leftover transaction before resuming migrations", async () => {
  const mongoose = require("mongoose");
  await Meta.create({ _id: "schema", version: 1 });
  const invoiceId = new mongoose.Types.ObjectId();
  await Selling.collection.insertOne({
    _id: invoiceId, number: "INV-LOCKED", customerName: "locked migrated invoice",
    sellingDate: new Date("2025-08-01"), totalPrice: 1, items: [], refunds: [],
    stage16OriginalTotalsRestored: true, shippingLocation: "old", createdAt: new Date(), updatedAt: new Date(),
  });
  const uri = `mongodb://127.0.0.1:${mongoose.connection.port}/${mongoose.connection.name}?replicaSet=rs0&directConnection=true`;
  const client = new mongoose.mongo.MongoClient(uri);
  await client.connect();
  const session = client.startSession();
  session.startTransaction();
  await client.db().collection("sellings").updateOne(
    { _id: invoiceId }, { $set: { customerName: "uncommitted lock" } }, { session }
  );
  const oldLanMode = process.env.NOTA_LAN_MODE;
  const oldMongoUri = process.env.MONGO_URI;
  process.env.NOTA_LAN_MODE = "1";
  process.env.MONGO_URI = uri;
  try {
  assert.equal(await runMigrations(), 7);
  } finally {
    if (oldLanMode === undefined) delete process.env.NOTA_LAN_MODE; else process.env.NOTA_LAN_MODE = oldLanMode;
    if (oldMongoUri === undefined) delete process.env.MONGO_URI; else process.env.MONGO_URI = oldMongoUri;
    await session.abortTransaction().catch(() => {});
    await session.endSession().catch(() => {});
    await client.close();
  }
  assert.equal((await Meta.findById("schema")).version, 7);
  assert.equal((await Selling.collection.findOne({ _id: invoiceId })).shippingLocation, undefined);
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

test("ensureIndexes builds late-added indexes with autoIndex off and refuses to start on a blocked unique index", { skip: mongodSkipReason }, async () => {
  const mongoose = require("mongoose");
  const { ensureIndexes } = require("../src/config/db");
  const User = require("../src/models/user.model");
  await User.collection.dropIndexes().catch(() => {});
  const schema = new mongoose.Schema({ code: String }, { autoIndex: false, collection: "ensure_idx_probe" });
  const Probe = mongoose.model("EnsureIdxProbe", schema);
  await Probe.createCollection();
  await Probe.collection.insertMany([{ code: "x" }, { code: "x" }]);
  await Probe.init();
  assert.equal((await Probe.collection.indexes()).some((index) => index.name === "code_1"), false);

  // Standing in for an index added by a later stage: it does not exist until the next start.
  Probe.schema.index({ code: 1 }, { unique: true });
  await assert.rejects(ensureIndexes(), (error) => {
    assert.match(error.message, /ensure_idx_probe/);
    assert.match(error.message, /EnsureIdxProbe/);
    return true;
  });
  assert.equal(await Probe.collection.countDocuments(), 2, "no data is dropped");

  await Probe.collection.deleteOne({});
  await ensureIndexes();
  assert.equal((await Probe.collection.indexes()).some((index) => index.name === "code_1"), true);
  const userIndexes = (await User.collection.indexes()).map((index) => index.name);
  assert.ok(userIndexes.includes("username_1"));
  assert.ok(userIndexes.includes("one_owner"));
  mongoose.deleteModel("EnsureIdxProbe");
  await Probe.collection.drop();
});
