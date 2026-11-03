process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");

// firebase-admin is mocked through require.cache so no real credentials or network are used.
const firebaseState = {
  apps: [],
  initializeCalls: [],
  sendCalls: [],
  sendImpl: async ({ tokens }) => ({
    successCount: tokens.length,
    failureCount: 0,
    responses: tokens.map(() => ({ success: true })),
  }),
};

const mockModule = (id, exports) => {
  const filename = require.resolve(id);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

mockModule("firebase-admin/app", {
  cert: (serviceAccount) => ({ serviceAccount }),
  getApps: () => firebaseState.apps,
  initializeApp: (options, name) => {
    const app = { name, options };
    firebaseState.initializeCalls.push(app);
    firebaseState.apps.push(app);
    return app;
  },
});
mockModule("firebase-admin/messaging", {
  getMessaging: () => ({
    sendEachForMulticast: async (message) => {
      firebaseState.sendCalls.push(message);
      return firebaseState.sendImpl(message);
    },
  }),
});

const app = require("../src/app");
const DeviceToken = require("../src/models/deviceToken.model");
const Product = require("../src/models/product.model");
const ShippingSetting = require("../src/models/shippingSetting.model");
const WebsiteOrder = require("../src/models/websiteOrder.model");
const {
  buildNewWebsiteOrderMessage,
  notifyNewWebsiteOrder,
  resetPushNotificationsForTests,
  resolveServiceAccountPath,
} = require("../src/services/pushNotification.service");

const API_KEY = "test-notifications-key";
const ORDER_ID = new mongoose.Types.ObjectId("66b0b7b5a8c197aa0adf9999");
const PRODUCT_ID = new mongoose.Types.ObjectId("66b0b7b5a8c197aa0adf1234");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kapomatic-push-"));
const serviceAccountPath = path.join(tempDir, "kapomatic-firebase-adminsdk.json");
fs.writeFileSync(
  serviceAccountPath,
  JSON.stringify({
    type: "service_account",
    project_id: "kapomatic-test",
    private_key: "fake",
    client_email: "push@kapomatic-test.iam.gserviceaccount.com",
  })
);

const originals = {
  deviceFind: DeviceToken.find,
  deviceFindOneAndUpdate: DeviceToken.findOneAndUpdate,
  deviceDeleteOne: DeviceToken.deleteOne,
  deviceDeleteMany: DeviceToken.deleteMany,
  productFind: Product.find,
  shippingFindOne: ShippingSetting.findOne,
  websiteOrderCreate: WebsiteOrder.create,
  consoleWarn: console.warn,
  consoleError: console.error,
  consoleLog: console.log,
};

let logs;

test.beforeEach(() => {
  process.env.NOTIFICATIONS_API_KEY = API_KEY;
  process.env.FIREBASE_SERVICE_ACCOUNT = serviceAccountPath;
  firebaseState.apps = [];
  firebaseState.initializeCalls = [];
  firebaseState.sendCalls = [];
  firebaseState.sendImpl = async ({ tokens }) => ({
    successCount: tokens.length,
    failureCount: 0,
    responses: tokens.map(() => ({ success: true })),
  });
  resetPushNotificationsForTests();

  logs = { warn: [], error: [], log: [] };
  console.warn = (...args) => logs.warn.push(args.join(" "));
  console.error = (...args) => logs.error.push(args.join(" "));
  console.log = (...args) => logs.log.push(args.join(" "));
});

test.afterEach(() => {
  DeviceToken.find = originals.deviceFind;
  DeviceToken.findOneAndUpdate = originals.deviceFindOneAndUpdate;
  DeviceToken.deleteOne = originals.deviceDeleteOne;
  DeviceToken.deleteMany = originals.deviceDeleteMany;
  Product.find = originals.productFind;
  ShippingSetting.findOne = originals.shippingFindOne;
  WebsiteOrder.create = originals.websiteOrderCreate;
  console.warn = originals.consoleWarn;
  console.error = originals.consoleError;
  console.log = originals.consoleLog;
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const stubDeviceTokens = (tokens) => {
  const calls = { find: 0, deleteMany: [] };
  DeviceToken.find = () => {
    calls.find += 1;
    return {
      select() {
        return this;
      },
      lean: async () => tokens.map((token) => ({ token })),
    };
  };
  DeviceToken.deleteMany = async (filter) => {
    calls.deleteMany.push(filter);
    return { deletedCount: filter.token.$in.length };
  };
  return calls;
};

const withServer = async (callback) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const registerRequest = (baseUrl, body, headers = { "X-Notifications-Key": API_KEY }) =>
  fetch(`${baseUrl}/api/notifications/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const sampleOrder = () => ({
  _id: ORDER_ID,
  customerName: "Ahmed Ali",
  customerPhone: "+201234567890",
  shippingLocation: "Cairo, Nasr City",
  government: "Cairo",
  transferPhone: "+201111111111",
  totalPrice: 1250,
  items: [{ productName: "Oil" }, { productName: "Filter" }, { productName: "Gear" }],
});

test("resolveServiceAccountPath accepts Windows, POSIX, quoted, and empty values", () => {
  assert.equal(resolveServiceAccountPath(undefined), null);
  assert.equal(resolveServiceAccountPath("   "), null);
  assert.equal(resolveServiceAccountPath('""'), null);
  assert.equal(
    resolveServiceAccountPath("C:\\keys\\sa.json"),
    path.resolve("C:\\keys\\sa.json")
  );
  assert.equal(resolveServiceAccountPath("C:/keys/sa.json"), path.resolve("C:/keys/sa.json"));
  assert.equal(
    resolveServiceAccountPath('  "C:\\Program Files\\keys\\sa.json"  '),
    path.resolve("C:\\Program Files\\keys\\sa.json")
  );
  assert.equal(
    resolveServiceAccountPath("'/etc/kapomatic/sa.json'"),
    path.resolve("/etc/kapomatic/sa.json")
  );
});

test("POST /api/notifications/devices rejects a missing or wrong key", async () => {
  let updateCalled = false;
  DeviceToken.findOneAndUpdate = () => {
    updateCalled = true;
  };

  await withServer(async (baseUrl) => {
    const missing = await registerRequest(baseUrl, { token: "abc", platform: "android" }, {});
    assert.equal(missing.status, 401);

    const wrong = await registerRequest(
      baseUrl,
      { token: "abc", platform: "android" },
      { "X-Notifications-Key": "nope" }
    );
    assert.equal(wrong.status, 401);
  });

  assert.equal(updateCalled, false);
});

test("notification endpoints return 503 when NOTIFICATIONS_API_KEY is not configured", async () => {
  delete process.env.NOTIFICATIONS_API_KEY;

  await withServer(async (baseUrl) => {
    const register = await registerRequest(baseUrl, { token: "abc", platform: "android" });
    assert.equal(register.status, 503);

    const unregister = await fetch(`${baseUrl}/api/notifications/devices/abc`, {
      method: "DELETE",
      headers: { "X-Notifications-Key": "" },
    });
    assert.equal(unregister.status, 503);
  });
});

test("POST /api/notifications/devices validates token and platform", async () => {
  await withServer(async (baseUrl) => {
    const missingToken = await registerRequest(baseUrl, { platform: "android" });
    assert.equal(missingToken.status, 400);

    const badPlatform = await registerRequest(baseUrl, { token: "abc", platform: "web" });
    assert.equal(badPlatform.status, 400);

    const tooLong = await registerRequest(baseUrl, {
      token: "x".repeat(4097),
      platform: "android",
    });
    assert.equal(tooLong.status, 400);
  });
});

test("POST /api/notifications/devices upserts the token and refreshes lastSeenAt", async () => {
  const calls = [];
  DeviceToken.findOneAndUpdate = (filter, update, options) => {
    calls.push({ filter, update, options });
    return {
      lean: async () => ({
        _id: new mongoose.Types.ObjectId(),
        token: filter.token,
        platform: update.$set.platform,
        createdAt: update.$setOnInsert.createdAt,
        lastSeenAt: update.$set.lastSeenAt,
      }),
    };
  };

  await withServer(async (baseUrl) => {
    const response = await registerRequest(baseUrl, {
      token: "  device-token-1  ",
      platform: "ANDROID",
    });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["createdAt", "lastSeenAt", "platform", "token"]);
    assert.equal(body.token, "device-token-1");
    assert.equal(body.platform, "android");
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].filter, { token: "device-token-1" });
  assert.equal(calls[0].update.$set.platform, "android");
  assert.ok(calls[0].update.$set.lastSeenAt instanceof Date);
  assert.equal(calls[0].update.$setOnInsert.token, "device-token-1");
  assert.equal(calls[0].options.upsert, true);
});

test("DELETE /api/notifications/devices/:token removes the token", async () => {
  const deleted = [];
  DeviceToken.deleteOne = async (filter) => {
    deleted.push(filter);
    return { deletedCount: 1 };
  };
  const token = "abc:APA91b/with+chars";

  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(
      `${baseUrl}/api/notifications/devices/${encodeURIComponent(token)}`,
      { method: "DELETE" }
    );
    assert.equal(unauthorized.status, 401);

    const response = await fetch(
      `${baseUrl}/api/notifications/devices/${encodeURIComponent(token)}`,
      { method: "DELETE", headers: { "X-Notifications-Key": API_KEY } }
    );
    assert.equal(response.status, 204);
  });

  assert.deepEqual(deleted, [{ token }]);
});

test("new order message contains only order id, total, and item count", () => {
  const message = buildNewWebsiteOrderMessage(sampleOrder());
  const serialized = JSON.stringify(message);

  assert.deepEqual(Object.keys(message).sort(), ["android", "data", "notification"]);
  assert.deepEqual(message.data, {
    type: "website_order",
    orderId: String(ORDER_ID),
    totalPrice: "1250",
    itemCount: "3",
    route: "/website-orders",
  });
  assert.equal(message.notification.title, "طلب جديد من الموقع");
  assert.match(message.notification.body, /1,250/);
  assert.match(message.notification.body, /3/);
  assert.equal(message.android.notification.channelId, "website_orders");

  for (const personal of ["Ahmed Ali", "+201234567890", "Nasr City", "Cairo", "+201111111111"]) {
    assert.equal(serialized.includes(personal), false, `message leaks ${personal}`);
  }
});

test("notifyNewWebsiteOrder skips with one warning when Firebase is not configured", async () => {
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  const calls = stubDeviceTokens(["a"]);

  assert.deepEqual(await notifyNewWebsiteOrder(sampleOrder()), { skipped: true });
  assert.deepEqual(await notifyNewWebsiteOrder(sampleOrder()), { skipped: true });

  assert.equal(calls.find, 0);
  assert.equal(firebaseState.sendCalls.length, 0);
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /FIREBASE_SERVICE_ACCOUNT is not set/);
});

test("notifyNewWebsiteOrder skips when the service account file is missing", async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT = path.join(tempDir, "missing.json");
  stubDeviceTokens(["a"]);

  assert.deepEqual(await notifyNewWebsiteOrder(sampleOrder()), { skipped: true });
  assert.equal(firebaseState.initializeCalls.length, 0);
  assert.match(logs.warn[0], /Could not load the Firebase service account/);
});

test("notifyNewWebsiteOrder warns about a dotenv-mangled Windows path", async () => {
  // dotenv expands \n inside double quotes: "C:\new\sa.json" becomes "C:" + newline + "ew\sa.json".
  process.env.FIREBASE_SERVICE_ACCOUNT = "C:\new\\sa.json";
  stubDeviceTokens(["a"]);

  assert.deepEqual(await notifyNewWebsiteOrder(sampleOrder()), { skipped: true });
  assert.match(logs.warn[0], /control character/);
});

test("notifyNewWebsiteOrder loads a quoted service account path", async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT = `"${serviceAccountPath}"`;
  stubDeviceTokens(["token-1"]);

  const result = await notifyNewWebsiteOrder(sampleOrder());

  assert.deepEqual(result, { sent: 1, failed: 0, removed: 0 });
  assert.equal(firebaseState.initializeCalls.length, 1);
  assert.equal(
    firebaseState.initializeCalls[0].options.credential.serviceAccount.project_id,
    "kapomatic-test"
  );
});

test("notifyNewWebsiteOrder sends to all tokens and deletes only stale ones", async () => {
  const calls = stubDeviceTokens(["ok", "unregistered", "invalid", "quota", "ok"]);
  firebaseState.sendImpl = async ({ tokens }) => {
    const errors = {
      unregistered: "messaging/registration-token-not-registered",
      invalid: "messaging/invalid-registration-token",
      quota: "messaging/quota-exceeded",
    };
    const responses = tokens.map((token) =>
      errors[token] ? { success: false, error: { code: errors[token] } } : { success: true }
    );
    return {
      successCount: responses.filter((response) => response.success).length,
      failureCount: responses.filter((response) => !response.success).length,
      responses,
    };
  };

  const result = await notifyNewWebsiteOrder(sampleOrder());

  assert.equal(firebaseState.sendCalls.length, 1);
  assert.deepEqual(firebaseState.sendCalls[0].tokens, ["ok", "unregistered", "invalid", "quota"]);
  assert.deepEqual(firebaseState.sendCalls[0].data, buildNewWebsiteOrderMessage(sampleOrder()).data);
  assert.deepEqual(result, { sent: 1, failed: 3, removed: 2 });
  assert.deepEqual(calls.deleteMany, [{ token: { $in: ["unregistered", "invalid"] } }]);
  assert.match(logs.error.join("\n"), /messaging\/quota-exceeded/);
});

test("notifyNewWebsiteOrder splits more than 500 tokens into batches", async () => {
  const tokens = Array.from({ length: 501 }, (_, index) => `token-${index}`);
  stubDeviceTokens(tokens);

  const result = await notifyNewWebsiteOrder(sampleOrder());

  assert.deepEqual(
    firebaseState.sendCalls.map((call) => call.tokens.length),
    [500, 1]
  );
  assert.deepEqual(result, { sent: 501, failed: 0, removed: 0 });
});

test("notifyNewWebsiteOrder does nothing when no devices are registered", async () => {
  stubDeviceTokens([]);

  assert.deepEqual(await notifyNewWebsiteOrder(sampleOrder()), { sent: 0, failed: 0, removed: 0 });
  assert.equal(firebaseState.sendCalls.length, 0);
});

test("notifyNewWebsiteOrder never rejects when FCM or the database fails", async () => {
  stubDeviceTokens(["a"]);
  firebaseState.sendImpl = async () => {
    throw new Error("FCM unavailable");
  };
  assert.deepEqual(await notifyNewWebsiteOrder(sampleOrder()), { sent: 0, failed: 1, removed: 0 });

  DeviceToken.find = () => {
    throw new Error("database down");
  };
  const result = await notifyNewWebsiteOrder(sampleOrder());
  assert.equal(result.error.message, "database down");
  assert.match(logs.error.join("\n"), /database down/);
});

const stubCheckoutModels = () => {
  ShippingSetting.findOne = () => ({
    lean: async () => ({
      governmentFees: [{ government: "Cairo", shippingFees: 50 }],
      freeShippingMinimumAmount: 0,
    }),
  });
  Product.find = () => ({
    populate: async () => [
      { _id: PRODUCT_ID, name: "Oil", code: "OIL-1", category: { name: "Oils" } },
    ],
  });
  WebsiteOrder.create = async (data) => ({
    ...data,
    _id: ORDER_ID,
    status: "pending",
    items: data.items.map((item, index) => ({
      ...item,
      _id: new mongoose.Types.ObjectId(`66b0b7b5a8c197aa0adf000${index}`),
    })),
  });
};

const checkoutPayload = {
  customerName: "Ahmed Ali",
  customerPhone: "+201234567890",
  government: "Cairo",
  shippingLocation: "Cairo, Nasr City",
  paymentMethod: "cash",
  sellingDate: "2026-10-30T10:00:00.000Z",
  products: [{ productId: String(PRODUCT_ID), price: 600, quantity: 2 }],
};

const postCheckout = (baseUrl) =>
  fetch(`${baseUrl}/api/cart/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(checkoutPayload),
  });

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
};

test("checkout response is unchanged and still 201 when the push send fails", async () => {
  stubCheckoutModels();

  // Baseline: push disabled.
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  const baseline = await withServer(async (baseUrl) => {
    const response = await postCheckout(baseUrl);
    return { status: response.status, body: await response.json() };
  });
  assert.equal(baseline.status, 201);
  assert.equal(baseline.body.totalPrice, 1250);
  assert.equal(baseline.body.itemCount, 1);

  // Push enabled, but FCM rejects.
  resetPushNotificationsForTests();
  process.env.FIREBASE_SERVICE_ACCOUNT = serviceAccountPath;
  stubDeviceTokens(["device-1"]);
  firebaseState.sendImpl = async () => {
    throw new Error("FCM unavailable");
  };

  const failing = await withServer(async (baseUrl) => {
    const response = await postCheckout(baseUrl);
    const result = { status: response.status, body: await response.json() };
    await waitFor(() => logs.error.some((line) => line.includes("FCM unavailable")));
    return result;
  });

  assert.deepEqual(failing, baseline);
  assert.equal(firebaseState.sendCalls.length, 1);
  assert.deepEqual(firebaseState.sendCalls[0].data, {
    type: "website_order",
    orderId: String(ORDER_ID),
    totalPrice: "1250",
    itemCount: "1",
    route: "/website-orders",
  });
});

test("checkout does not send a notification when validation fails", async () => {
  stubCheckoutModels();
  stubDeviceTokens(["device-1"]);

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cart/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...checkoutPayload, government: "Atlantis" }),
    });
    assert.equal(response.status, 400);
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(firebaseState.sendCalls.length, 0);
});
