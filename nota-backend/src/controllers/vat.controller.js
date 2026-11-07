const ExcelJS = require("exceljs");
const VatEvent = require("../models/vatEvent.model");
const VatReturn = require("../models/vatReturn.model");
const VatPayment = require("../models/vatPayment.model");
const CashBox = require("../models/cashBox.model");
const { postEntry, line, accountMap, boxAccount } = require("../accounting/posting");
const { loadVatSettings, lastFiledPeriod, touchVatLock, today } = require("../accounting/vat");
const { monthOf, nextMonth, round2 } = require("../utils/vat");
const { nextDocumentNumber, PREFIXES } = require("../utils/documentNumber");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const boxes = require("../cashbox/boxes");
const { positiveAmount, optionalDate, optionalText, requiredReason } = require("../cashbox/validate");

const { httpError } = boxes;

// Stage 21: the monthly VAT return.
//   prepare: output VAT (sales - sales returns) and input VAT (purchases + expenses - purchase returns) of a vatPeriod, read ONLY
//            from the stored VatEvent rows, plus the credit carried from the previous filed return:
//            net = output - input - carriedIn
//   file:    one transaction. offset = min(output, input + carriedIn), SIGNED (no clamp): positive -> Dr VAT_PAYABLE / Cr VAT_INPUT,
//            negative (a month whose sales returns exceed its sales) -> Dr VAT_INPUT / Cr VAT_PAYABLE. net > 0 is payable for the
//            month (it stays on VAT_PAYABLE until paid); net < 0 is a credit that stays on VAT_INPUT and carries forward.
//            Either way VAT_PAYABLE keeps exactly output - offset = max(net, 0) and VAT_INPUT keeps input + carriedIn - offset = credit.
//   A month can be filed only after it has ended (period < the month of today, local): 409 PERIOD_NOT_ENDED.
//   pay:     VP, Dr VAT_PAYABLE / Cr box, partial allowed. unfile: owner only, latest return only, no payment, a reason.
// Returns are filed in month order with no gaps (409 OUT_OF_ORDER), and a document dated in a filed month lands in the first
// unfiled month after it (accounting/vat.js periodFor), so a filed return never changes.

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const requirePeriod = (value) => {
  if (typeof value !== "string" || !PERIOD.test(value)) throw httpError(400, "INVALID_PERIOD", "الشهر غير صالح (YYYY-MM)");
  return value;
};

const GROUPS = {
  sales: ["sale", "sale_edit", "sale_cancel"],
  returns: ["sale_return"],
  purchases: ["purchase", "purchase_cancel"],
  purchaseReturns: ["purchase_return"],
  expenses: ["expense", "expense_cancel"],
};

/** The signed offset of a month: min(output, input + carriedIn). Shared by prepare, list, file and the health check. */
const offsetOf = (output, input, carriedIn) => round2(Math.min(output, input + carriedIn));

const sumsByPeriod = async (match, session) => {
  const rows = await VatEvent.aggregate([{ $match: match }, { $group: { _id: { period: "$period", direction: "$direction" }, vat: { $sum: "$vat" }, net: { $sum: "$net" } } }]).session(session || null);
  const byPeriod = new Map();
  for (const row of rows) {
    const entry = byPeriod.get(row._id.period) || { output: 0, input: 0, outputNet: 0, inputNet: 0 };
    entry[row._id.direction] = round2(row.vat); entry[`${row._id.direction}Net`] = round2(row.net);
    byPeriod.set(row._id.period, entry);
  }
  return byPeriod;
};

/** The figures of one period. Filed: the stored ones. Open: computed now from the events and the previous filed return. */
const figuresFor = async (period, session) => {
  const filed = await VatReturn.findOne({ period, status: "filed" }).session(session || null).lean();
  if (filed) return { filed, output: filed.output, input: filed.input, carriedIn: filed.carriedIn, net: filed.net, offset: filed.offset, payable: filed.payable, credit: filed.credit };
  const sums = (await sumsByPeriod({ period }, session)).get(period) || { output: 0, input: 0 };
  const prior = await VatReturn.findOne({ status: "filed", period: { $lt: period } }).sort({ period: -1 }).session(session || null).lean();
  const carriedIn = prior ? prior.credit : 0;
  const net = round2(sums.output - sums.input - carriedIn);
  return { filed: null, output: sums.output, input: sums.input, carriedIn, net, offset: offsetOf(sums.output, sums.input, carriedIn), payable: Math.max(net, 0), credit: Math.max(-net, 0) };
};

const paidOf = async (returnId, session) => {
  const rows = await VatPayment.aggregate([{ $match: { returnId, status: "posted" } }, { $group: { _id: null, paid: { $sum: "$amount" } } }]).session(session || null);
  return rows.length ? round2(rows[0].paid) : 0;
};

const statusOf = (figures, paid) => {
  if (!figures.filed) return "open";
  if (figures.payable <= 0) return "filed";
  if (paid <= 0) return "filed";
  return round2(figures.payable - paid) <= 0 ? "paid" : "partial";
};

/** The only month that may be filed next: the month after the last filed one (the first ever: the earliest month with VAT). */
const nextPeriod = async (session) => {
  const last = await lastFiledPeriod(session);
  if (last) return nextMonth(last);
  const first = await VatEvent.findOne({}).sort({ period: 1 }).select("period").session(session || null).lean();
  if (first) return first.period;
  const settings = await loadVatSettings(session);
  return monthOf(settings.startDate || today());
};

const view = (period, figures, paid) => ({
  period, status: statusOf(figures, paid),
  output: figures.output, input: figures.input, carriedIn: figures.carriedIn, net: figures.net, offset: figures.offset, payable: figures.payable, credit: figures.credit,
  paid, remaining: figures.filed ? Math.max(0, round2(figures.payable - paid)) : 0,
  returnId: figures.filed ? figures.filed._id : null, number: figures.filed ? figures.filed.number : null, filedAt: figures.filed ? figures.filed.filedAt : null,
});

// GET /api/vat/returns (vat.file | accounting.view): every month with VAT activity, newest first.
const listReturns = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const [settings, next, filed] = await Promise.all([loadVatSettings(), nextPeriod(), VatReturn.find({ status: "filed" }).sort({ period: 1 }).lean()]);
  const sums = await sumsByPeriod({});
  const periods = [...new Set([...sums.keys(), ...filed.map((row) => row.period), next, monthOf(today())])].sort().reverse();
  const paymentRows = await VatPayment.aggregate([{ $match: { status: "posted" } }, { $group: { _id: "$returnId", paid: { $sum: "$amount" } } }]);
  const paidBy = new Map(paymentRows.map((row) => [String(row._id), round2(row.paid)]));
  const filedBy = new Map(filed.map((row) => [row.period, row]));
  const rows = periods.map((period) => {
    const stored = filedBy.get(period);
    if (stored) return view(period, { filed: stored, output: stored.output, input: stored.input, carriedIn: stored.carriedIn, net: stored.net, offset: stored.offset, payable: stored.payable, credit: stored.credit }, paidBy.get(String(stored._id)) || 0);
    const entry = sums.get(period) || { output: 0, input: 0 };
    const prior = [...filed].reverse().find((row) => row.period < period);
    const carriedIn = prior ? prior.credit : 0;
    const net = round2(entry.output - entry.input - carriedIn);
    return view(period, { filed: null, output: entry.output, input: entry.input, carriedIn, net, offset: offsetOf(entry.output, entry.input, carriedIn), payable: Math.max(net, 0), credit: Math.max(-net, 0) }, 0);
  });
  res.json({ data: rows, nextPeriod: next, settings: { enabled: settings.enabled, rate: settings.rate, pricesIncludeVat: settings.pricesIncludeVat, startDate: settings.startDate } });
};

const linesOf = async (period) => {
  const events = await VatEvent.find({ period }).sort({ date: 1, createdAt: 1 }).lean();
  const out = {};
  for (const [group, kinds] of Object.entries(GROUPS)) {
    out[group] = events.filter((event) => kinds.includes(event.kind)).map((event) => ({ kind: event.kind, number: event.number || null, date: event.date, net: event.net, vat: event.vat, sourceType: event.sourceType, sourceId: event.sourceId }));
  }
  return out;
};

// GET /api/vat/returns/:period: the figures, the documents behind them, the payments and the posting a filing would make.
const getReturn = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const period = requirePeriod(req.params.period);
  const figures = await figuresFor(period);
  const payments = figures.filed ? await VatPayment.find({ returnId: figures.filed._id, status: "posted" }).sort({ date: 1, createdAt: 1 }).lean() : [];
  const paid = round2(payments.reduce((sum, row) => sum + row.amount, 0));
  const [next, last] = await Promise.all([nextPeriod(), lastFiledPeriod()]);
  const boxNames = new Map((await CashBox.find({}).select("name").lean()).map((box) => [String(box._id), box.name]));
  res.json({
    ...view(period, figures, paid),
    lines: await linesOf(period),
    payments: payments.map((row) => ({ _id: row._id, number: row.number, date: row.date, amount: row.amount, boxId: row.boxId, boxName: boxNames.get(String(row.boxId)) || null, reference: row.reference || null, note: row.note || null })),
    canFile: !figures.filed && period === next && period < monthOf(today()),
    canUnfile: Boolean(figures.filed) && period === last && paid === 0,
    preview: figures.filed ? null : { debit: { code: figures.offset < 0 ? "115" : "22", amount: Math.abs(figures.offset) }, credit: { code: figures.offset < 0 ? "22" : "115", amount: Math.abs(figures.offset) }, payable: figures.payable, credit_carried: figures.credit },
  });
};

// GET /api/vat/returns/:period/export: the figures and every document behind them, as an Excel workbook.
const exportReturn = async (req, res) => {
  const period = requirePeriod(req.params.period);
  const figures = await figuresFor(period);
  const lines = await linesOf(period);
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("VAT return");
  summary.addRows([["Period", period], ["Output VAT", figures.output], ["Input VAT", figures.input], ["Carried-in credit", figures.carriedIn], ["Net payable", figures.net], ["Status", figures.filed ? "filed" : "open"]]);
  const titles = { sales: "Sales", returns: "Sales returns", purchases: "Purchases", purchaseReturns: "Purchase returns", expenses: "Expenses" };
  for (const [group, title] of Object.entries(titles)) {
    const sheet = workbook.addWorksheet(title);
    sheet.addRow(["Number", "Date", "Kind", "Net", "VAT"]);
    for (const row of lines[group]) sheet.addRow([row.number, new Date(row.date).toISOString().slice(0, 10), row.kind, row.net, row.vat]);
    sheet.addRow(["Total", "", "", round2(lines[group].reduce((sum, row) => sum + row.net, 0)), round2(lines[group].reduce((sum, row) => sum + row.vat, 0))]);
  }
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="vat-${period}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
};

// POST /api/vat/returns/:period/file (vat.file)
const fileReturn = async (req, res) => {
  const period = requirePeriod(req.params.period);
  const filed = await withTransaction(async (session) => {
    await touchVatLock(session);
    if (await VatReturn.exists({ period, status: "filed" }).session(session)) throw httpError(409, "ALREADY_FILED", "الإقرار ده اتقدم قبل كده");
    const expected = await nextPeriod(session);
    if (period !== expected) throw httpError(409, "OUT_OF_ORDER", `الإقرارات بتتقدم بالترتيب. الشهر الجاي هو ${expected}`, { expected });
    if (period >= monthOf(today())) throw httpError(409, "PERIOD_NOT_ENDED", "الشهر ده لسه ما خلصش. الإقرار بيتقدم بعد نهاية الشهر", { period, today: monthOf(today()) });
    const figures = await figuresFor(period, session);
    const number = await nextDocumentNumber(PREFIXES.VAT_RETURN, session);
    const [created] = await VatReturn.create([{
      number, period, output: figures.output, input: figures.input, carriedIn: figures.carriedIn, net: figures.net, offset: figures.offset,
      payable: figures.payable, credit: figures.credit, status: "filed", filedAt: new Date(), filedBy: req.user?._id, filedByName: req.user?.name,
    }], { session });
    if (figures.offset !== 0) {
      const accounts = await accountMap(["VAT_PAYABLE", "VAT_INPUT"], session);
      const amount = Math.abs(figures.offset);
      // Positive: the output is offset against input. Negative: the month's returns exceeded its sales, so the VAT that was
      // taken back from VAT_PAYABLE is put back there and moves to VAT_INPUT as a credit.
      const [debitKey, creditKey] = figures.offset > 0 ? ["VAT_PAYABLE", "VAT_INPUT"] : ["VAT_INPUT", "VAT_PAYABLE"];
      await postEntry({ date: today(), source: { type: "vat_return", id: created._id, number }, memo: `VAT return ${period}`, session, lines: [
        line(accounts.get(debitKey), amount, "debit"), line(accounts.get(creditKey), amount, "credit"),
      ] });
    }
    await audit(req, { action: "vat.filed", entity: "VatReturn", entityId: created._id, details: { number, period, output: figures.output, input: figures.input, carriedIn: figures.carriedIn, net: figures.net, offset: figures.offset }, session, strict: true });
    return created;
  });
  res.status(201).json(view(period, await figuresFor(period), 0));
};

// POST /api/vat/returns/:period/pay { amount, boxId?, date?, reference?, note? } (vat.file): Dr VAT_PAYABLE / Cr box.
const payReturn = async (req, res) => {
  const period = requirePeriod(req.params.period);
  const body = req.body || {};
  const amount = positiveAmount(body.amount);
  const date = optionalDate(body.date);
  const reference = optionalText(body.reference, 100, "المرجع");
  const note = optionalText(body.note, 500);
  const payment = await withTransaction(async (session) => {
    const vatReturn = await VatReturn.findOne({ period, status: "filed" }).session(session);
    if (!vatReturn) throw httpError(409, "NOT_FILED", "الإقرار لسه ما اتقدمش");
    // The return is written first, so two payments (or a payment and an unfiling) conflict and one retries on fresh numbers.
    await VatReturn.collection.updateOne({ _id: vatReturn._id }, { $currentDate: { updatedAt: true } }, { session });
    const remaining = round2(vatReturn.payable - await paidOf(vatReturn._id, session));
    if (remaining <= 0) throw httpError(409, "NOTHING_DUE", "مفيش ضريبة مستحقة على الشهر ده");
    if (round2(amount - remaining) > 0) throw httpError(409, "EXCEEDS_REMAINING", "المبلغ أكبر من المتبقي على الإقرار", { remaining, amount });
    const box = await boxes.resolveBox({ req, boxId: body.boxId, session, direction: "out" });
    await boxes.lockBoxes([box._id], session);
    const balance = await boxes.boxBalance(box, session);
    if (round2(balance - amount) < 0) throw httpError(409, "INSUFFICIENT_BALANCE", "رصيد الخزنة مش كفاية", { boxId: box._id, balance, required: amount });
    const number = await nextDocumentNumber(PREFIXES.VAT_PAYMENT, session);
    const [created] = await VatPayment.create([{ number, returnId: vatReturn._id, period, date, amount, boxId: box._id, reference, note }], { session });
    const accounts = await accountMap(["VAT_PAYABLE"], session);
    await postEntry({ date, source: { type: "vat_payment", id: created._id, number }, memo: `VAT payment ${period}`, session, lines: [
      line(accounts.get("VAT_PAYABLE"), amount, "debit"), line(await boxAccount(box._id, session), amount, "credit"),
    ] });
    await audit(req, { action: "vat.paid", entity: "VatPayment", entityId: created._id, details: { number, period, amount, box: box.name }, session, strict: true });
    return created;
  });
  const figures = await figuresFor(period);
  res.status(201).json({ payment, return: view(period, figures, await paidOf(figures.filed._id)) });
};

// POST /api/vat/returns/:period/unfile { reason } (vat.file, owner only): the latest filed return, with no payment.
const unfileReturn = async (req, res) => {
  const period = requirePeriod(req.params.period);
  if (req.authEnabled && req.user?.role !== "owner") throw httpError(403, "OWNER_ONLY", "إلغاء تقديم الإقرار للمالك فقط");
  const reason = requiredReason(req.body && req.body.reason);
  await withTransaction(async (session) => {
    await touchVatLock(session);
    const vatReturn = await VatReturn.findOne({ period, status: "filed" }).session(session);
    if (!vatReturn) throw httpError(409, "NOT_FILED", "الإقرار لسه ما اتقدمش");
    const last = await lastFiledPeriod(session);
    if (last !== period) throw httpError(409, "NOT_LATEST", "ينفع تلغي تقديم آخر إقرار بس");
    if (await VatPayment.exists({ returnId: vatReturn._id, status: "posted" }).session(session)) throw httpError(409, "HAS_PAYMENTS", "الإقرار عليه سداد. مينفعش يتلغي تقديمه");
    await boxes.reverseSourceEntries("vat_return", vatReturn._id, { date: today(), memo: `VAT return ${period} unfiled: ${reason}`, session });
    vatReturn.status = "unfiled"; vatReturn.unfileReason = reason; vatReturn.unfiledAt = new Date(); vatReturn.unfiledBy = req.user?._id;
    await vatReturn.save({ session });
    await audit(req, { action: "vat.unfiled", entity: "VatReturn", entityId: vatReturn._id, details: { number: vatReturn.number, period, reason }, session, strict: true });
  });
  res.json(view(period, await figuresFor(period), 0));
};

module.exports = { listReturns, getReturn, exportReturn, fileReturn, payReturn, unfileReturn, figuresFor, sumsByPeriod };
