const financial = require("../reports/financial");
const { buildWorkbook } = require("../reports/excel");

// Stage 22: GET /api/reports/* (reports.financial). Every report is one GET; `format=xlsx` returns the same report as an Excel file.
//   /income-statement?from&to&compare=1      /balance-sheet?asOf      /trial-balance?from&to
//   /box-movements?from&to                    /party-balances?type=customers|suppliers

const send = async (req, res, report, filename) => {
  res.set("Cache-Control", "no-store");
  if (req.query.format === "xlsx") {
    const workbook = buildWorkbook(report);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
    return;
  }
  res.json(report);
};

const isTrue = (value) => value === "1" || value === "true";

const getIncomeStatement = async (req, res) => {
  const range = financial.parseRange(req.query);
  const report = await financial.incomeStatement({ range, compare: isTrue(req.query.compare) });
  await send(req, res, report, `income-statement_${report.period.from}_${report.period.to}`);
};

const getBalanceSheet = async (req, res) => {
  const asOfDay = req.query.asOf ? financial.parseDay(req.query.asOf, "التاريخ") : financial.parseDay(financial.dayString(new Date()), "التاريخ");
  const report = await financial.balanceSheet({ asOfDay });
  await send(req, res, report, `balance-sheet_${report.asOf}`);
};

const getTrialBalance = async (req, res) => {
  const range = financial.parseRange(req.query);
  const report = await financial.trialBalance({ range });
  await send(req, res, report, `trial-balance_${report.period.from}_${report.period.to}`);
};

const getBoxMovements = async (req, res) => {
  const range = financial.parseRange(req.query);
  const report = await financial.boxMovements({ range });
  await send(req, res, report, `box-movements_${report.period.from}_${report.period.to}`);
};

const getPartyBalances = async (req, res) => {
  const type = req.query.type === "customers" || req.query.type === "suppliers" ? req.query.type : "all";
  const report = await financial.partyBalances({ type });
  await send(req, res, report, `party-balances_${report.asOf}`);
};

module.exports = { getIncomeStatement, getBalanceSheet, getTrialBalance, getBoxMovements, getPartyBalances };
