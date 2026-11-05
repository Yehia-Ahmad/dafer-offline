process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const mongoose = require("mongoose");

const BACKEND = path.resolve(__dirname, "..");
const REPO = path.resolve(BACKEND, "..");
const MONGOD = process.env.NOTA_TEST_MONGOD || path.join(REPO, "nota-frontend", "vendor", "mongodb", "bin", process.platform === "win32" ? "mongod.exe" : "mongod");
const OLD_COMMIT = "d5113d6";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});
const waitForPort = async (port, child, label) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited with ${child.exitCode}`);
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await delay(100);
  }
  throw new Error(`${label} did not open port ${port}`);
};
const waitForHttp = async (baseUrl, child, label) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited with ${child.exitCode}`);
    try { if ((await fetch(baseUrl)).ok) return; } catch (_error) {}
    await delay(100);
  }
  throw new Error(`${label} did not start`);
};
const stopChild = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(10000)]);
};
const request = async (baseUrl, method, route, body) => {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${text}`);
  return json;
};

async function main() {
  assert.ok(fs.existsSync(MONGOD), `real mongod not found: ${MONGOD}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nota-stage16-legacy-"));
  const archive = path.join(temp, "old-backend.tar");
  const dataPath = path.join(temp, "db");
  fs.mkdirSync(dataPath);
  let mongod;
  let oldBackend;
  let currentBackend;
  try {
    const archived = spawnSync("git", ["archive", "--format=tar", "--output", archive, OLD_COMMIT, "nota-backend"], { cwd: REPO, encoding: "utf8" });
    assert.equal(archived.status, 0, archived.stderr);
    const extracted = spawnSync("tar", ["-xf", archive, "-C", temp], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stderr);

    const mongoPort = await freePort();
    const oldPort = await freePort();
    const currentPort = await freePort();
    mongod = spawn(MONGOD, ["--dbpath", dataPath, "--port", String(mongoPort), "--bind_ip", "127.0.0.1", "--replSet", "rs0", "--logpath", path.join(temp, "mongod.log"), "--wiredTigerCacheSizeGB", "0.25"], { windowsHide: true, stdio: "ignore" });
    await waitForPort(mongoPort, mongod, "mongod");
    const bootstrap = new mongoose.mongo.MongoClient(`mongodb://127.0.0.1:${mongoPort}`, { directConnection: true });
    await bootstrap.connect();
    await bootstrap.db("admin").command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }] } });
    for (;;) {
      const hello = await bootstrap.db("admin").command({ hello: 1 });
      if (hello.isWritablePrimary) break;
      await delay(100);
    }
    await bootstrap.close();
    const mongoUri = `mongodb://127.0.0.1:${mongoPort}/nota_legacy?replicaSet=rs0&directConnection=true`;
    const childEnv = { ...process.env, MONGO_URI: mongoUri, NOTA_AUTH: "", NODE_PATH: path.join(BACKEND, "node_modules") };
    oldBackend = spawn(process.execPath, [path.join(temp, "nota-backend", "src", "server.js")], {
      cwd: path.join(temp, "nota-backend"), env: { ...childEnv, PORT: String(oldPort) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForHttp(`http://127.0.0.1:${oldPort}`, oldBackend, "old backend");
    const oldBase = `http://127.0.0.1:${oldPort}`;
    const category = await request(oldBase, "POST", "/api/categories", { name: "Legacy fixtures" });
    const product = await request(oldBase, "POST", "/api/products", {
      name: "Legacy product", code: "LEGACY-1", categoryId: category._id, inventoryCount: 50,
      purchasePrice: 20, wholesalePrice: 30, retailPrice: 100,
    });
    const customer = async (name, phone) => request(oldBase, "POST", "/api/customers", { name, phone });
    const sale = async (name, phone, quantity, extra = {}) => request(oldBase, "POST", "/api/sellings", {
      customerName: name, customerPhone: phone, sellingDate: "2025-01-01",
      items: [{ productId: product._id, quantity, price: 100 }], ...extra,
    });
    const credit = async (customerId, quantity, extra = {}) => request(oldBase, "POST", "/api/credit-sales", {
      customerId, sellingDate: "2025-01-01", dueDate: "2025-02-01",
      items: [{ productId: product._id, quantity, price: 100 }], ...extra,
    });
    const makeReturn = (returnType, invoice, quantity, extra = {}) => request(oldBase, "POST", "/api/returns", {
      returnType, invoiceId: invoice._id, items: [{ itemId: invoice.items[0]._id, quantity }], returnDate: "2025-01-02", ...extra,
    });

    const cashPartial = await sale("Cash partial", "01010000001", 3);
    await makeReturn("cash", cashPartial, 1);
    const cashFull = await sale("Cash full", "01010000002", 2);
    await makeReturn("cash", cashFull, 2);

    const discountCustomer = await customer("Discount return", "01010000003");
    const discountCredit = await credit(discountCustomer._id, 3, { discountAmount: 10, shippingFees: 5 });
    await makeReturn("credit", discountCredit, 3, { refundAll: true });

    const reallocCustomer = await customer("Reallocation", "01010000004");
    const d1 = await credit(reallocCustomer._id, 2);
    const d2 = await credit(reallocCustomer._id, 1);
    await request(oldBase, "POST", `/api/credit-sales/${d1._id}/payments`, { amount: 150, paymentDate: "2025-01-01" });
    await makeReturn("credit", d1, 1);

    const downCustomer = await customer("Down payment", "01010000005");
    const down = await credit(downCustomer._id, 1, { initialPaidAmount: 20, initialPaymentDate: "2025-01-01" });
    await stopChild(oldBackend);
    oldBackend = null;

    currentBackend = spawn(process.execPath, [path.join(BACKEND, "src", "server.js")], {
      cwd: BACKEND, env: { ...childEnv, PORT: String(currentPort) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let currentErrors = "";
    currentBackend.stderr.on("data", (chunk) => { currentErrors += chunk.toString(); });
    await waitForHttp(`http://127.0.0.1:${currentPort}`, currentBackend, "current backend");
    const currentBase = `http://127.0.0.1:${currentPort}`;

    const sellings = await request(currentBase, "GET", "/api/sellings?limit=100");
    const partialRow = sellings.data.find((invoice) => invoice.customerName === "Cash partial");
    assert.ok(partialRow);
    const partialInvoice = await request(currentBase, "GET", `/api/sellings/${partialRow._id}`);
    assert.equal(partialInvoice.items[0].returnedQuantity, 1);
    const fullReturns = await request(currentBase, "GET", "/api/returns?customerName=Cash%20full");
    assert.equal(fullReturns.data.length, 1);
    assert.equal(fullReturns.data[0].finalReturnedAmount, 200);
    assert.match(fullReturns.data[0].number, /^RT-/);
    const profit = await request(currentBase, "GET", `/api/products/${product._id}/profit-report`);
    const partialProfit = profit[0].invoices.find((invoice) => String(invoice.invoiceId) === String(partialInvoice.invoiceId));
    assert.deepEqual({ quantity: partialProfit.quantity, revenue: partialProfit.revenue, profit: partialProfit.profit }, { quantity: 2, revenue: 200, profit: 160 });

    const discountStatement = await request(currentBase, "GET", `/api/customers/${discountCustomer._id}/statement`);
    assert.equal(discountStatement.totals.balance, 0);
    const reallocStatement = await request(currentBase, "GET", `/api/customers/${reallocCustomer._id}/statement`);
    assert.equal(reallocStatement.totals.balance, 50);
    const migratedD1 = await request(currentBase, "GET", `/api/credit-sales/${d1._id}`);
    assert.equal(migratedD1.items.length, 1);
    assert.equal(migratedD1.items[0].productQuantity, 2);
    assert.equal(migratedD1.items[0].returnedQuantity, 1);
    assert.equal(migratedD1.items[0].costEstimated, false);
    const migratedD2 = await request(currentBase, "GET", `/api/credit-sales/${d2._id}`);
    assert.equal(migratedD2.remainingAmount, 50);
    const cancelledDown = await request(currentBase, "POST", `/api/credit-sales/${down._id}/cancel`, { reason: "legacy down payment" });
    assert.equal(cancelledDown.cancelRefundAmount, 20);

    const db = new mongoose.mongo.MongoClient(mongoUri);
    await db.connect();
    const receiptCount = await db.db().collection("receipts").countDocuments({ customer: new mongoose.Types.ObjectId(reallocCustomer._id) });
    assert.equal(receiptCount, 1, "the automatic reallocation must not create an RC receipt");
    await db.close();
    assert.doesNotMatch(currentErrors, /TypeError/);
    console.log("legacy migration scenarios passed: cash partial/full, discount+shipping credit return, reallocation, down payment, partial-line merge");
  } finally {
    await stopChild(oldBackend);
    await stopChild(currentBackend);
    await stopChild(mongod);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
