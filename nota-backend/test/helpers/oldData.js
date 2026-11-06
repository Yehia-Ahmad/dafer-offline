// Simulates an install from before Stage 19: no cash boxes, and no money document knows its box.
// (The Stage 17/18 tests re-create the ledger on top of documents made through the API.)
const CashBox = require("../../src/models/cashBox.model");
const Selling = require("../../src/models/selling.model");
const CreditSale = require("../../src/models/creditSale.model");
const Receipt = require("../../src/models/receipt.model");
const ReturnLog = require("../../src/models/returnLog.model");

async function forgetBoxes() {
  await CashBox.deleteMany({});
  await Selling.collection.updateMany({}, { $unset: { boxId: "" } });
  await Receipt.collection.updateMany({}, { $unset: { boxId: "" } });
  await ReturnLog.collection.updateMany({}, { $unset: { boxId: "" } });
  await CreditSale.collection.updateMany({}, { $unset: { cancelRefundBoxId: "" } });
}

module.exports = { forgetBoxes };
