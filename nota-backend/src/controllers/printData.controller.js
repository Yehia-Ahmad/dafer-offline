const mongoose = require("mongoose");
const Receipt = require("../models/receipt.model");
const CreditSale = require("../models/creditSale.model");
const Customer = require("../models/customer.model");
const CashBox = require("../models/cashBox.model");
const Purchase = require("../models/purchase.model");
const PurchaseReturn = require("../models/purchaseReturn.model");
const SupplierPayment = require("../models/supplierPayment.model");
const Supplier = require("../models/supplier.model");
const JournalEntry = require("../models/journalEntry.model");
const Account = require("../models/account.model");
const Product = require("../models/product.model");
const Category = require("../models/category.model");
const { loadCustomerStatement } = require("../services/customerStatement.service");
const { loadSupplierDocuments, statementFor } = require("../services/supplierStatement.service");
const { hasPermission, httpError } = require("../auth/middleware");
const { roundMoney } = require("../utils/invoicePricing");
const { DEFAULT_LOW_STOCK_THRESHOLD } = require("../utils/lowStock");

// Stage 23: GET .../print-data. Only the documents whose screen does not already hold everything the
// designed print shows. Every number is a STORED value (the statement's running balance, the
// journal entry's lines): nothing is recomputed for the print.

const isId = (value) => mongoose.Types.ObjectId.isValid(value);
const can = (req, key) => !req.authEnabled || hasPermission(req.user, key);

// GET /api/customers/:id/receipts/:number/print-data (customers.view or credit.collect)
// The receipt, its allocations (invoice numbers) and the customer's balance before and after it,
// read from the customer statement's own running balance (a debit = the customer owes us).
const getReceiptPrintData = async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!isId(req.params.id)) throw httpError(404, "RECEIPT_NOT_FOUND", "الإيصال غير موجود");
  const number = String(req.params.number || "").trim().toUpperCase();
  const receipt = await Receipt.findOne({ number, customer: req.params.id }).lean();
  if (!receipt) throw httpError(404, "RECEIPT_NOT_FOUND", "الإيصال غير موجود");
  const [customer, box, sales, statement] = await Promise.all([
    Customer.findById(receipt.customer).select("name phone taxNumber").lean(),
    receipt.boxId ? CashBox.findById(receipt.boxId).select("name").lean() : null,
    CreditSale.find({ _id: { $in: receipt.allocations.map((row) => row.creditSale).filter(Boolean) } }).select("number").lean(),
    loadCustomerStatement(receipt.customer),
  ]);
  const numberOf = new Map(sales.map((sale) => [String(sale._id), sale.number]));
  const line = statement.lines.find((row) => row.type === "payment" && row.number === number);
  const balanceAfter = line ? line.balance : null;
  res.json({
    receipt: {
      _id: receipt._id, number: receipt.number, amount: receipt.amount, paymentDate: receipt.paymentDate, note: receipt.note || "", kind: receipt.kind,
      boxName: box ? box.name : null, createdByName: receipt.createdByName || null, createdAt: receipt.createdAt,
      allocations: receipt.allocations.map((row) => ({ amount: row.amount, invoiceNumber: row.creditSale ? numberOf.get(String(row.creditSale)) || null : null, opening: Boolean(row.opening) })),
    },
    customer: customer ? { _id: customer._id, name: customer.name, phone: customer.phone || "", taxNumber: customer.taxNumber || "" } : null,
    balanceBefore: balanceAfter === null ? null : roundMoney(balanceAfter + receipt.amount),
    balanceAfter,
  });
};

// GET /api/purchases/:id/print-data (purchases.view)
// The purchase (as the detail screen shows it), the supplier's balance before and after it (the supplier
// statement's running balance; positive = we owe), and the posted journal entry (number + lines).
// The journal lines need accounting.view, like the journal screen; without it only the number is sent.
const getPurchasePrintData = async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!isId(req.params.id)) throw httpError(404, "PURCHASE_NOT_FOUND", "فاتورة الشراء غير موجودة");
  const purchase = await Purchase.findById(req.params.id).lean();
  if (!purchase) throw httpError(404, "PURCHASE_NOT_FOUND", "فاتورة الشراء غير موجودة");
  const [supplier, returns, payment, box, entry] = await Promise.all([
    Supplier.findById(purchase.supplierId).lean(),
    PurchaseReturn.find({ purchaseId: purchase._id }).sort({ createdAt: 1 }).lean(),
    purchase.pvId ? SupplierPayment.findById(purchase.pvId).lean() : null,
    purchase.boxId ? CashBox.findById(purchase.boxId).select("name").lean() : null,
    JournalEntry.findOne({ "source.type": "purchase", "source.id": purchase._id, type: "auto" }).lean(),
  ]);
  let balanceBefore = null;
  let balanceAfter = null;
  if (supplier) {
    const docs = await loadSupplierDocuments([supplier._id]);
    const lines = statementFor(supplier, docs).lines;
    const line = lines.find((row) => row.type === "purchase" && row.number === purchase.number);
    // The payment made with the invoice is its own statement line right after it: "after" is the balance once that is taken too.
    const paid = payment && payment.status !== "cancelled" ? lines.find((row) => row.type === "payment" && row.number === payment.number) : null;
    if (line) { balanceBefore = roundMoney(line.balance - line.credit); balanceAfter = paid ? paid.balance : line.balance; }
  }
  let journal = null;
  if (entry) {
    journal = { _id: entry._id, number: entry.number, date: entry.date, lines: null };
    if (can(req, "accounting.view")) {
      const accounts = await Account.find({ _id: { $in: entry.lines.map((row) => row.accountId) } }).select("code nameAr nameEn").lean();
      const byId = new Map(accounts.map((row) => [String(row._id), row]));
      journal.lines = entry.lines.map((row) => {
        const account = byId.get(String(row.accountId));
        return { accountCode: account ? account.code : null, accountNameAr: account ? account.nameAr : null, accountNameEn: account ? account.nameEn : null, debit: row.debit, credit: row.credit };
      });
    }
  }
  res.json({
    purchase, returns,
    supplier: supplier ? { _id: supplier._id, name: supplier.name, phone: supplier.phone || "", address: supplier.address || "", taxNumber: supplier.taxNumber || "" } : null,
    boxName: box ? box.name : null,
    payment: payment ? { number: payment.number, amount: payment.amount, status: payment.status } : null,
    balanceBefore, balanceAfter, journal,
  });
};

// GET /api/products/print-data?categoryId= (products.view)
// Every active product (optionally one category), by category then name, for the stock count sheet.
// purchasePrice is a cost field: the response goes through costStrip, so a user without
// products.viewCost never receives it (and the print hides the cost and value columns).
const getStockPrintData = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const filter = { isArchived: { $ne: true } };
  if (req.query.categoryId) {
    if (!isId(req.query.categoryId)) throw httpError(400, "INVALID_CATEGORY", "الفئة غير صالحة");
    filter.category = req.query.categoryId;
  }
  const [products, categories] = await Promise.all([
    Product.find(filter).select("name code inventoryCount lowStockThreshold retailPrice purchasePrice category").lean(),
    Category.find({}).select("name").lean(),
  ]);
  const names = new Map(categories.map((row) => [String(row._id), row.name]));
  const rows = products.map((product) => {
    const threshold = Number.isFinite(product.lowStockThreshold) ? product.lowStockThreshold : DEFAULT_LOW_STOCK_THRESHOLD;
    return {
      _id: product._id, name: product.name, code: product.code || "", categoryId: product.category ? String(product.category) : null,
      categoryName: product.category ? names.get(String(product.category)) || "" : "",
      inventoryCount: product.inventoryCount || 0, lowStockThreshold: threshold, lowStock: (product.inventoryCount || 0) <= threshold,
      retailPrice: product.retailPrice, purchasePrice: product.purchasePrice,
    };
  }).sort((a, b) => a.categoryName.localeCompare(b.categoryName, "ar") || a.name.localeCompare(b.name, "ar"));
  res.json({ products: rows, count: rows.length });
};

module.exports = { getReceiptPrintData, getPurchasePrintData, getStockPrintData };
