const mongoose = require("mongoose");
const Supplier = require("../models/supplier.model");
const Product = require("../models/product.model");
const Purchase = require("../models/purchase.model");
const PurchaseReturn = require("../models/purchaseReturn.model");
const CashBox = require("../models/cashBox.model");
const { postEntry, line, accountMap, postInventoryValueAdjustment } = require("../accounting/posting");
const { allocateCosts, weightedAverage, round4 } = require("../accounting/purchaseCost");
const { nextDocumentNumber, normalizeNumberSearch, PREFIXES } = require("../utils/documentNumber");
const { roundMoney } = require("../utils/invoicePricing");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const boxes = require("../cashbox/boxes");
const { nonNegativeAmount, positiveAmount, optionalDate, optionalText, requiredReason } = require("../cashbox/validate");
const { can } = require("./cashbox.controller");
const { postSupplierPayment, postSupplierRefund, balanceOf, touchSupplier } = require("./supplierAccount.controller");

const { httpError, isId } = boxes;

// Stage 20: purchase invoices (PO), purchase returns (PR) and cancelling a purchase.
//
// Cost rules (the whole stage hangs on them):
//  - a line's cost = its value - the invoice discount + other costs, allocated by line value (the last line takes the remainder);
//  - the product cost becomes the moving weighted average, rounded to 2 decimals (the purchase cost when stock <= 0);
//  - INVENTORY must stay = Σ stock × purchasePrice, so the entry debits INVENTORY with the value the stock really gained
//    and puts the rounding difference to INVENTORY_ADJUSTMENT in the same entry.
// A purchase is NOT a cost revaluation: no Stage 17 revaluation entry is posted for it.

const partyOf = (supplier) => ({ partyType: "supplier", partyId: supplier._id, partyName: supplier.name });

/** Debit when amount > 0, credit when < 0 (a zero line is dropped by postEntry). */
const signed = (account, amount, extra) => line(account, Math.abs(amount), amount >= 0 ? "debit" : "credit", extra);

const readItems = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) throw httpError(400, "ITEMS_REQUIRED", "أضف صنف واحد على الأقل");
  if (raw.length > 300) throw httpError(400, "TOO_MANY_ITEMS", "عدد الأصناف كبير");
  return raw.map((row, index) => {
    const productId = row && row.productId;
    if (!isId(productId)) throw httpError(400, "INVALID_PRODUCT", `الصنف رقم ${index + 1} غير صالح`);
    const qty = typeof row.qty === "string" && row.qty.trim() !== "" ? Number(row.qty) : row.qty;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0 || qty > 1e7) throw httpError(400, "INVALID_QTY", `كمية الصنف رقم ${index + 1} لازم تكون عدد صحيح أكبر من صفر`);
    const unitPrice = nonNegativeAmount(row.unitPrice, `سعر الصنف رقم ${index + 1}`);
    return { productId: String(productId), qty, unitPrice };
  });
};

const purchaseView = (purchase, boxNames) => ({ ...(purchase.toObject ? purchase.toObject() : purchase), boxName: purchase.boxId ? boxNames?.get(String(purchase.boxId)) || null : null });
const boxNameMap = async () => new Map((await CashBox.find({}).select("name").lean()).map((box) => [String(box._id), box.name]));

// POST /api/purchases (purchases.create)
// { supplierId, supplierInvoiceNo?, date?, items: [{ productId, qty, unitPrice }], discountAmount?, otherCosts?, paidAmount?, boxId?, notes? }
const createPurchase = async (req, res) => {
  const body = req.body || {};
  if (!isId(body.supplierId)) throw httpError(400, "INVALID_SUPPLIER", "اختار المورد");
  const items = readItems(body.items);
  const date = optionalDate(body.date);
  const supplierInvoiceNo = optionalText(body.supplierInvoiceNo, 60, "رقم فاتورة المورد");
  const notes = optionalText(body.notes, 1000);
  const discountAmount = body.discountAmount === undefined || body.discountAmount === "" ? 0 : nonNegativeAmount(body.discountAmount, "الخصم");
  const otherCosts = body.otherCosts === undefined || body.otherCosts === "" ? 0 : nonNegativeAmount(body.otherCosts, "المصاريف");
  const paidAmount = body.paidAmount === undefined || body.paidAmount === "" ? 0 : nonNegativeAmount(body.paidAmount, "المدفوع");
  const lineTotals = items.map((row) => roundMoney(row.qty * row.unitPrice));
  const subtotal = roundMoney(lineTotals.reduce((sum, value) => sum + value, 0));
  if (discountAmount > subtotal) throw httpError(400, "DISCOUNT_TOO_LARGE", "الخصم أكبر من إجمالي الفاتورة");
  const { lineCosts, total } = allocateCosts(lineTotals, discountAmount, otherCosts);
  if (total <= 0) throw httpError(400, "TOTAL_REQUIRED", "إجمالي الفاتورة لازم يكون أكبر من صفر");
  if (paidAmount > total) throw httpError(400, "PAID_EXCEEDS_TOTAL", "المدفوع أكبر من إجمالي الفاتورة");
  // Paying is a separate permission: a storekeeper's purchase is "آجل كله" unless a payer does it.
  if (paidAmount > 0 && !can(req, "suppliers.pay")) throw httpError(403, "PAY_NOT_ALLOWED", "مفيش صلاحية دفع للموردين. سجّل الفاتورة آجل");

  const purchase = await withTransaction(async (session) => {
    const supplier = await Supplier.findById(body.supplierId).session(session);
    if (!supplier) throw httpError(404, "SUPPLIER_NOT_FOUND", "المورد غير موجود");
    if (supplier.isActive === false) throw httpError(409, "SUPPLIER_INACTIVE", "المورد موقوف");
    const accounts = await accountMap(["INVENTORY", "INVENTORY_ADJUSTMENT", "SUPPLIERS"], session);

    // Stock and cost, line by line (two lines of one product see each other's result).
    const rows = []; let stockValueChange = 0;
    for (let index = 0; index < items.length; index += 1) {
      const row = items[index];
      const product = await Product.findById(row.productId).session(session).lean();
      if (!product) throw httpError(404, "PRODUCT_NOT_FOUND", "صنف في الفاتورة مش موجود");
      if (product.isArchived) throw httpError(409, "PRODUCT_ARCHIVED", `الصنف ${product.name} مؤرشف`);
      const oldQty = Number(product.inventoryCount || 0); const oldCost = Number(product.purchasePrice || 0);
      const newCost = weightedAverage(oldQty, oldCost, row.qty, lineCosts[index]);
      await Product.updateOne({ _id: product._id }, { $inc: { inventoryCount: row.qty }, $set: { purchasePrice: newCost } }, { session });
      stockValueChange += (oldQty + row.qty) * newCost - oldQty * oldCost;
      rows.push({
        _id: new mongoose.Types.ObjectId(), productId: product._id, name: product.name, code: product.code, qty: row.qty, unitPrice: row.unitPrice,
        lineTotal: lineTotals[index], lineCost: lineCosts[index], unitCost: round4(lineCosts[index] / row.qty), newAverageCost: newCost,
      });
    }
    stockValueChange = roundMoney(stockValueChange);

    const purchaseId = new mongoose.Types.ObjectId();
    const pvId = paidAmount > 0 ? new mongoose.Types.ObjectId() : undefined;
    const number = await nextDocumentNumber(PREFIXES.PURCHASE_ORDER, session);
    const [created] = await Purchase.create([{
      _id: purchaseId, number, supplierId: supplier._id, supplierName: supplier.name, supplierInvoiceNo, date, items: rows, subtotal, discountAmount, otherCosts, total,
      paidAmount, pvId, notes,
    }], { session });
    // Entry 1, the purchase: Dr INVENTORY (the value the stock really gained) / Cr SUPPLIERS = total.
    // The difference to the invoice total (the 2-decimal rounding of the new averages) is INVENTORY_ADJUSTMENT.
    await postEntry({ date, source: { type: "purchase", id: created._id, number }, memo: `Purchase ${number}`, session, lines: [
      signed(accounts.get("INVENTORY"), stockValueChange), signed(accounts.get("INVENTORY_ADJUSTMENT"), roundMoney(total - stockValueChange)),
      line(accounts.get("SUPPLIERS"), total, "credit", partyOf(supplier)),
    ] });
    // Entry 2, what was paid with it: the PV, Dr SUPPLIERS / Cr box.
    if (paidAmount > 0) {
      const { payment, box } = await postSupplierPayment({ req, session, supplier, amount: paidAmount, boxId: body.boxId, date, note: `Paid with ${number}`, purchase: created, id: pvId });
      created.boxId = box._id; await created.save({ session });
      created._pv = payment;
    }
    await audit(req, { action: "purchase.created", entity: "Purchase", entityId: created._id, details: { number, supplier: supplier.name, total, paidAmount, rounding: roundMoney(total - stockValueChange) }, session, strict: true });
    return created;
  });
  const boxNames = await boxNameMap();
  res.status(201).json({ ...purchaseView(purchase, boxNames), pvNumber: purchase._pv ? purchase._pv.number : null, supplierBalanceAfter: await balanceOf(purchase.supplierId) });
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET /api/purchases?supplier=&from=&to=&status=&search=&page=&limit= (purchases.view)
const getPurchases = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const filter = {};
  if (req.query.supplier) { if (!isId(req.query.supplier)) throw httpError(400, "INVALID_SUPPLIER", "المورد غير صالح"); filter.supplierId = new mongoose.Types.ObjectId(req.query.supplier); }
  if (req.query.status) { if (!["posted", "cancelled"].includes(req.query.status)) throw httpError(400, "INVALID_STATUS", "الحالة غير صالحة"); filter.status = req.query.status; }
  for (const [key, op] of [["from", "$gte"], ["to", "$lte"]]) {
    if (!req.query[key]) continue;
    const date = new Date(req.query[key]);
    if (Number.isNaN(date.getTime())) throw httpError(400, "INVALID_DATE", "التاريخ غير صالح");
    if (key === "to" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) date.setUTCHours(23, 59, 59, 999);
    filter.date = { ...(filter.date || {}), [op]: date };
  }
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ number: normalizeNumberSearch(search, PREFIXES.PURCHASE_ORDER) }, { supplierInvoiceNo: regex }, { supplierName: regex }];
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const [rows, totalItems, names] = await Promise.all([
    Purchase.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Purchase.countDocuments(filter), boxNameMap(),
  ]);
  res.json({ data: rows.map((row) => purchaseView(row, names)), pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
};

// GET /api/purchases/:id (purchases.view): the purchase, its PV and its returns.
const getPurchase = async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!isId(req.params.id)) throw httpError(404, "PURCHASE_NOT_FOUND", "فاتورة الشراء غير موجودة");
  const purchase = await Purchase.findById(req.params.id).lean();
  if (!purchase) throw httpError(404, "PURCHASE_NOT_FOUND", "فاتورة الشراء غير موجودة");
  const SupplierPayment = require("../models/supplierPayment.model");
  const [returns, payment, names] = await Promise.all([PurchaseReturn.find({ purchaseId: purchase._id }).sort({ createdAt: 1 }).lean(), purchase.pvId ? SupplierPayment.findById(purchase.pvId).lean() : null, boxNameMap()]);
  res.json({ ...purchaseView(purchase, names), returns, payment: payment ? { _id: payment._id, number: payment.number, amount: payment.amount, status: payment.status, boxId: payment.boxId } : null });
};

// POST /api/purchases/:id/cancel { reason } (purchases.cancel)
const cancelPurchase = async (req, res) => {
  const reason = requiredReason(req.body && req.body.reason);
  if (!isId(req.params.id)) throw httpError(404, "PURCHASE_NOT_FOUND", "فاتورة الشراء غير موجودة");
  const cancelled = await withTransaction(async (session) => {
    const purchase = await Purchase.findById(req.params.id).session(session);
    if (!purchase) throw httpError(404, "PURCHASE_NOT_FOUND", "فاتورة الشراء غير موجودة");
    if (purchase.status === "cancelled") throw httpError(409, "ALREADY_CANCELLED", "فاتورة الشراء ملغية بالفعل");
    if (await PurchaseReturn.exists({ purchaseId: purchase._id }).session(session)) throw httpError(409, "HAS_RETURNS", "الفاتورة عليها مرتجعات. مينفعش تتلغي");
    // Stock must still cover every line (conditional decrease, like a sale).
    const units = new Map();
    for (const item of purchase.items) {
      const result = await Product.updateOne({ _id: item.productId, inventoryCount: { $gte: item.qty } }, { $inc: { inventoryCount: -item.qty } }, { session });
      if (result.modifiedCount !== 1) throw httpError(409, "STOCK_ALREADY_USED", `الكمية اتباعت أو اتغيرت: ${item.name}`, { productId: item.productId });
      units.set(String(item.productId), (units.get(String(item.productId)) || 0) - item.qty);
    }
    const now = new Date();
    purchase.status = "cancelled"; purchase.cancelReason = reason; purchase.cancelledAt = now; purchase.cancelledBy = req.user?._id; purchase.cancelledByName = req.user?.name;
    await purchase.save({ session });
    // The purchase entry is reversed; the linked PV is NOT (the money was paid: the supplier shows an advance).
    const reversals = await boxes.reverseSourceEntries("purchase", purchase._id, { date: now, memo: `Purchase cancelled: ${reason}`, session });
    // INVENTORY leaves at the CURRENT cost (purchasePrice stays at the current average); the difference is INVENTORY_ADJUSTMENT.
    await postInventoryValueAdjustment({ restoredUnits: units, entries: reversals, date: now, source: { type: "purchase_cancel", id: purchase._id, number: purchase.number }, memo: `Purchase ${purchase.number} cancel cost`, session });
    await audit(req, { action: "purchase.cancelled", entity: "Purchase", entityId: purchase._id, details: { number: purchase.number, reason }, session, strict: true });
    return purchase;
  });
  res.json(cancelled);
};

// POST /api/purchases/:id/returns { items: [{ itemId, qty }], reason?, date?, refundAmount?, boxId? } (purchases.create)
const createPurchaseReturn = async (req, res) => {
  const body = req.body || {};
  if (!isId(req.params.id)) throw httpError(404, "PURCHASE_NOT_FOUND", "فاتورة الشراء غير موجودة");
  if (!Array.isArray(body.items) || body.items.length === 0) throw httpError(400, "ITEMS_REQUIRED", "اختار صنف للمرتجع");
  const wanted = new Map();
  for (const row of body.items) {
    if (!row || !isId(row.itemId)) throw httpError(400, "INVALID_ITEM", "صنف المرتجع غير صالح");
    const qty = typeof row.qty === "string" && row.qty.trim() !== "" ? Number(row.qty) : row.qty;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0) throw httpError(400, "INVALID_QTY", "كمية المرتجع لازم تكون عدد صحيح أكبر من صفر");
    wanted.set(String(row.itemId), (wanted.get(String(row.itemId)) || 0) + qty);
  }
  const date = optionalDate(body.date);
  const reason = optionalText(body.reason, 500, "السبب");
  const refundAmount = body.refundAmount === undefined || body.refundAmount === "" || Number(body.refundAmount) === 0 ? 0 : positiveAmount(body.refundAmount, "المسترد");
  if (refundAmount > 0 && !can(req, "suppliers.pay")) throw httpError(403, "PAY_NOT_ALLOWED", "استرداد الفلوس من المورد محتاج صلاحية سداد الموردين");

  const result = await withTransaction(async (session) => {
    const purchase = await Purchase.findById(req.params.id).session(session);
    if (!purchase) throw httpError(404, "PURCHASE_NOT_FOUND", "فاتورة الشراء غير موجودة");
    if (purchase.status !== "posted") throw httpError(409, "PURCHASE_CANCELLED", "فاتورة الشراء ملغية");
    const supplier = await Supplier.findById(purchase.supplierId).session(session);
    const accounts = await accountMap(["INVENTORY", "INVENTORY_ADJUSTMENT", "SUPPLIERS"], session);
    const returnItems = []; const units = new Map(); let total = 0; let inventoryAtCost = 0;
    for (const [itemId, qty] of wanted) {
      const item = purchase.items.id(itemId);
      if (!item) throw httpError(400, "INVALID_ITEM", "صنف المرتجع مش في الفاتورة");
      const available = item.qty - item.returnedQty;
      if (qty > available) throw httpError(409, "OVER_RETURN", `الكمية المرتجعة أكبر من المتاح (${available}) للصنف ${item.name}`, { itemId, available, requested: qty });
      // Value = qty × the line's unit cost; the last units of a line take the remainder, so a full return equals the line cost exactly.
      const value = qty === available ? roundMoney(item.lineCost - item.returnedValue) : roundMoney((item.lineCost * qty) / item.qty);
      const product = await Product.findOneAndUpdate({ _id: item.productId, inventoryCount: { $gte: qty } }, { $inc: { inventoryCount: -qty } }, { session, new: false }).lean();
      if (!product) throw httpError(409, "STOCK_ALREADY_USED", `المخزون مش كفاية للمرتجع: ${item.name}`, { productId: item.productId });
      item.returnedQty += qty; item.returnedValue = roundMoney(item.returnedValue + value);
      inventoryAtCost += qty * Number(product.purchasePrice || 0);
      total += value; units.set(String(item.productId), (units.get(String(item.productId)) || 0) - qty);
      returnItems.push({ itemId: item._id, productId: item.productId, name: item.name, qty, unitCost: round4(value / qty), value });
    }
    total = roundMoney(total); inventoryAtCost = roundMoney(inventoryAtCost);
    if (total <= 0) throw httpError(400, "NOTHING_TO_RETURN", "قيمة المرتجع صفر");
    await purchase.save({ session });
    const number = await nextDocumentNumber(PREFIXES.PURCHASE_RETURN, session);
    const [created] = await PurchaseReturn.create([{ number, purchaseId: purchase._id, supplierId: purchase.supplierId, date, items: returnItems, total, reason }], { session });
    // Dr SUPPLIERS = the line value. Cr INVENTORY = qty × the CURRENT cost (so INVENTORY = Σ stock × purchasePrice holds); the rest is INVENTORY_ADJUSTMENT.
    await postEntry({ date, source: { type: "purchase_return", id: created._id, number }, memo: reason || `Purchase return ${number}`, session, lines: [
      line(accounts.get("SUPPLIERS"), total, "debit", partyOf(supplier)), line(accounts.get("INVENTORY"), inventoryAtCost, "credit"),
      signed(accounts.get("INVENTORY_ADJUSTMENT"), roundMoney(inventoryAtCost - total)),
    ] });
    let refund = null;
    if (refundAmount > 0) {
      // Cash only comes back for what the supplier now owes US: min(return value, max(0, -balance after the return)). While we still
      // owe the supplier, a return only reduces what we owe. The supplier is written first so concurrent refunds conflict and retry.
      await touchSupplier(supplier._id, session);
      const owedToUs = Math.max(0, -(await balanceOf(supplier._id, session)));
      const cap = Math.min(total, owedToUs);
      if (roundMoney(refundAmount - cap) > 0) throw httpError(409, "REFUND_EXCEEDS_DUE", "المبلغ المسترد أكبر من اللي المورد مدينلنا بيه", { due: cap, total, refundAmount });
      ({ refund } = await postSupplierRefund({ req, session, supplier, amount: refundAmount, boxId: body.boxId, date, note: `Refund for ${number}`, purchaseReturnId: created._id }));
      created.refundId = refund._id; await created.save({ session });
    }
    await audit(req, { action: "purchase.returned", entity: "PurchaseReturn", entityId: created._id, details: { number, purchase: purchase.number, total, refund: refundAmount }, session, strict: true });
    return { created, refund };
  });
  res.status(201).json({ ...result.created.toObject(), refund: result.refund ? result.refund.toObject() : null, supplierBalanceAfter: await balanceOf(result.created.supplierId) });
};

module.exports = { createPurchase, getPurchases, getPurchase, cancelPurchase, createPurchaseReturn };
