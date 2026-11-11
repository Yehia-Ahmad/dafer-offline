// Stage 22: "Excel للمحاسب". Each report exports the same rows it shows, numbers as numbers, on a right-to-left sheet. Arabic labels
// (the app's own language); the shop name, the period and "بالجنيه" sit in the header like the screen.
const ExcelJS = require("exceljs");

const MONEY_FORMAT = "#,##0.00;(#,##0.00)";
const PERCENT_FORMAT = "0.00";

const headerLines = (sheet, { shopName, title, subtitle }, width) => {
  const lines = [shopName || "", title, subtitle];
  lines.forEach((text, index) => {
    const row = sheet.addRow([text]);
    sheet.mergeCells(index + 1, 1, index + 1, Math.max(width, 2));
    row.getCell(1).font = { bold: index < 2, size: index === 0 ? 14 : 12 };
    row.getCell(1).alignment = { horizontal: "center" };
  });
  sheet.addRow([]);
};

const styleHeaderRow = (row) => {
  row.font = { bold: true };
  row.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0EDE6" } }; cell.border = { bottom: { style: "thin" } }; cell.alignment = { horizontal: "center" }; });
};

const newSheet = (workbook, name, header, columns) => {
  const sheet = workbook.addWorksheet(name, { views: [{ rightToLeft: true }] });
  sheet.columns = columns.map((column) => ({ width: column.width || 16 }));
  headerLines(sheet, header, columns.length);
  styleHeaderRow(sheet.addRow(columns.map((column) => column.header)));
  return sheet;
};

const addMoney = (cell, value, format = MONEY_FORMAT) => { cell.value = value === null || value === undefined ? null : Number(value); cell.numFmt = format; };

const flatten = (rows, depth = 0, out = []) => {
  for (const row of rows) {
    out.push({ row, depth });
    if (row.children?.length) flatten(row.children, depth + 1, out);
  }
  return out;
};

const incomeStatementSheet = (workbook, report) => {
  const compare = Boolean(report.comparison);
  const subtitle = `${report.period.from} → ${report.period.to}${compare ? ` (مقارنة: ${report.comparison.from} → ${report.comparison.to})` : ""} · بالجنيه`;
  const columns = [{ header: "البند", width: 38 }, { header: "المبلغ", width: 16 }, ...(compare ? [{ header: "الفترة السابقة", width: 16 }, { header: "التغيير", width: 16 }] : [])];
  const sheet = newSheet(workbook, "قائمة الدخل", { shopName: report.shopName, title: "قائمة الدخل", subtitle }, columns);
  for (const { row, depth } of flatten(report.rows)) {
    const percent = row.kind === "percent";
    const factor = row.kind === "line" || row.kind === "group" ? row.sign : 1;
    const added = sheet.addRow([row.nameAr]);
    added.getCell(1).alignment = { indent: depth * 2 };
    addMoney(added.getCell(2), row.amount * factor, percent ? PERCENT_FORMAT : MONEY_FORMAT);
    if (compare) {
      addMoney(added.getCell(3), row.previous === null ? null : row.previous * factor, percent ? PERCENT_FORMAT : MONEY_FORMAT);
      addMoney(added.getCell(4), row.change === null ? null : row.change * factor, percent ? PERCENT_FORMAT : MONEY_FORMAT);
    }
    if (row.kind === "subtotal" || row.kind === "total" || row.kind === "group") added.font = { bold: true };
  }
};

const balanceSheetSheet = (workbook, report) => {
  const sheet = newSheet(workbook, "الميزانية", { shopName: report.shopName, title: "الميزانية", subtitle: `في ${report.asOf} · بالجنيه` }, [{ header: "البند", width: 38 }, { header: "الرصيد", width: 16 }, { header: "الجانب", width: 10 }]);
  const section = (title, root, total) => {
    const header = sheet.addRow([title]); header.font = { bold: true };
    for (const { row, depth } of flatten(root.children || [])) {
      const added = sheet.addRow([`${row.code ? `${row.code} · ` : ""}${row.nameAr}`]);
      added.getCell(1).alignment = { indent: depth * 2 };
      addMoney(added.getCell(2), row.amount);
      added.getCell(3).value = row.side === "debit" ? "مدين" : "دائن";
      if (row.kind === "group") added.font = { bold: true };
    }
    const totalRow = sheet.addRow([`إجمالي ${title}`]); addMoney(totalRow.getCell(2), total); totalRow.font = { bold: true };
    sheet.addRow([]);
  };
  section("الأصول", report.sections.assets, report.totals.assets);
  section("الخصوم", report.sections.liabilities, report.totals.liabilities);
  section("حقوق الملكية", report.sections.equity, report.totals.equity);
  const total = sheet.addRow(["الخصوم + حقوق الملكية"]); addMoney(total.getCell(2), report.totals.liabilitiesAndEquity); total.font = { bold: true };
  const check = sheet.addRow(["الفرق (الأصول − الخصوم − حقوق الملكية)"]); addMoney(check.getCell(2), report.check.difference);
};

const trialBalanceSheet = (workbook, report) => {
  const columns = [{ header: "الكود", width: 10 }, { header: "الحساب", width: 34 }, { header: "افتتاحي مدين" }, { header: "افتتاحي دائن" }, { header: "حركة مدين" }, { header: "حركة دائن" }, { header: "ختامي مدين" }, { header: "ختامي دائن" }];
  const sheet = newSheet(workbook, "ميزان المراجعة", { shopName: report.shopName, title: "ميزان المراجعة", subtitle: `${report.period.from} → ${report.period.to} · بالجنيه` }, columns);
  const keys = ["openingDebit", "openingCredit", "movementDebit", "movementCredit", "closingDebit", "closingCredit"];
  for (const { row, depth } of flatten(report.rows)) {
    const added = sheet.addRow([row.code, row.nameAr]);
    added.getCell(2).alignment = { indent: depth * 2 };
    keys.forEach((key, index) => addMoney(added.getCell(3 + index), row[key]));
    if (row.kind === "group") added.font = { bold: true };
  }
  const totals = sheet.addRow(["", "الإجمالي"]);
  keys.forEach((key, index) => addMoney(totals.getCell(3 + index), report.totals[key]));
  totals.font = { bold: true };
};

const boxMovementsSheet = (workbook, report) => {
  const header = { shopName: report.shopName, title: "حركة الخزائن", subtitle: `${report.period.from} → ${report.period.to} · بالجنيه` };
  const sheet = newSheet(workbook, "حركة الخزائن", header, [{ header: "الخزنة", width: 30 }, { header: "رصيد أول المدة" }, { header: "داخل" }, { header: "خارج" }, { header: "رصيد آخر المدة" }]);
  for (const box of report.boxes) {
    const row = sheet.addRow([box.name]);
    [box.opening, box.in, box.out, box.closing].forEach((value, index) => addMoney(row.getCell(2 + index), value));
  }
  const total = sheet.addRow(["الإجمالي"]);
  [report.totals.opening, report.totals.in, report.totals.out, report.totals.closing].forEach((value, index) => addMoney(total.getCell(2 + index), value));
  total.font = { bold: true };
  const detail = newSheet(workbook, "حسب النوع", header, [{ header: "الخزنة", width: 30 }, { header: "النوع", width: 26 }, { header: "داخل" }, { header: "خارج" }]);
  for (const box of report.boxes) for (const kind of box.byKind) {
    const row = detail.addRow([box.name, kind.ar]); addMoney(row.getCell(3), kind.in); addMoney(row.getCell(4), kind.out);
  }
};

const partySheet = (workbook, name, report, party) => {
  const columns = [{ header: "الاسم", width: 30 }, { header: "الرصيد" }, { header: "الجانب", width: 10 }, { header: "حالي" }, { header: "١–٣٠ يوم" }, { header: "٣١–٦٠ يوم" }, { header: "٦١–٩٠ يوم" }, { header: "أكتر من ٩٠" }, { header: "رصيد دائن / مقدم" }];
  const sheet = newSheet(workbook, name, { shopName: report.shopName, title: name, subtitle: `في ${report.asOf} · بالجنيه` }, columns);
  for (const row of party.rows) {
    const added = sheet.addRow([row.name]);
    addMoney(added.getCell(2), row.balance);
    added.getCell(3).value = row.side === "debit" ? "مدين" : "دائن";
    ["current", "d1_30", "d31_60", "d61_90", "d90plus"].forEach((bucket, index) => addMoney(added.getCell(4 + index), row.aging[bucket]));
    addMoney(added.getCell(9), row.advance);
  }
  const total = sheet.addRow(["الإجمالي"]);
  addMoney(total.getCell(2), party.totals.balance);
  ["current", "d1_30", "d31_60", "d61_90", "d90plus"].forEach((bucket, index) => addMoney(total.getCell(4 + index), party.totals[bucket]));
  addMoney(total.getCell(9), party.totals.advance);
  total.font = { bold: true };
};

const buildWorkbook = (report) => {
  const workbook = new ExcelJS.Workbook();
  switch (report.report) {
    case "income-statement": incomeStatementSheet(workbook, report); break;
    case "balance-sheet": balanceSheetSheet(workbook, report); break;
    case "trial-balance": trialBalanceSheet(workbook, report); break;
    case "box-movements": boxMovementsSheet(workbook, report); break;
    case "party-balances":
      if (report.customers) partySheet(workbook, "أرصدة العملاء", report, report.customers);
      if (report.suppliers) partySheet(workbook, "أرصدة الموردين", report, report.suppliers);
      break;
    default: throw new Error(`Unknown report ${report.report}`);
  }
  return workbook;
};

module.exports = { buildWorkbook };
