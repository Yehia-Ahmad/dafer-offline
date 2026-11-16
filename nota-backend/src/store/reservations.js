// Online Stage 4: stock reserved for website orders. The reserved quantity of a product is the sum of its quantities in
// orders that are `confirmed` or `preparing`. It is computed from WebOrder (index { status, items.productId }), never stored
// on the product, and nothing in the POS, credit sales or purchases reads it: the shop can still sell reserved stock.
const mongoose = require("mongoose");
const WebOrder = require("../models/webOrder.model");

const toObjectIds = (ids) => [...new Set(ids.map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));

/**
 * Map(productId string -> reserved qty) for the given products, one aggregation for any number of them.
 * @param excludeOrderId an order whose own lines must not count against itself (confirming or editing it)
 * @param before { at, id }: count only the orders confirmed before this one (dispatch: first come, first served)
 */
const reservedByProduct = async (productIds, { session = null, excludeOrderId = null, before = null } = {}) => {
  const ids = toObjectIds(productIds);
  if (!ids.length) return new Map();
  const match = { status: { $in: WebOrder.RESERVING_STATUSES }, "items.productId": { $in: ids } };
  if (excludeOrderId) match._id = { $ne: new mongoose.Types.ObjectId(String(excludeOrderId)) };
  const stages = [{ $match: match }];
  if (before) {
    // Queue priority: only orders that were confirmed EARLIER (ties by id) count, so the earlier order keeps its stock and
    // the later one is the one refused. Orders without confirmedAt (none expected) queue by their creation time.
    const id = new mongoose.Types.ObjectId(String(before.id));
    stages.push(
      { $addFields: { queueAt: { $ifNull: ["$confirmedAt", "$createdAt"] } } },
      { $match: { $or: [{ queueAt: { $lt: before.at } }, { queueAt: before.at, _id: { $lt: id } }] } }
    );
  }
  const rows = await WebOrder.aggregate([
    ...stages,
    { $unwind: "$items" },
    { $match: { "items.productId": { $in: ids } } },
    { $group: { _id: "$items.productId", qty: { $sum: "$items.qty" } } },
  ]).session(session);
  return new Map(rows.map((row) => [String(row._id), row.qty]));
};

/** Rows with `inventoryCount` lowered by what is reserved (never below 0): what the website may sell. Rows are plain objects. */
const withAvailableStock = async (rows, options = {}) => {
  const reserved = await reservedByProduct(rows.map((row) => row._id), options);
  return rows.map((row) => ({ ...row, inventoryCount: Math.max(0, Number(row.inventoryCount || 0) - (reserved.get(String(row._id)) || 0)) }));
};

module.exports = { reservedByProduct, withAvailableStock };
