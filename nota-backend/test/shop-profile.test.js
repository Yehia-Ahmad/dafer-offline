process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const test = require("node:test");

const ShopProfile = require("../src/models/shopProfile.model");
const app = require("../src/app");

// There is no database in these tests. Successful reads and writes go through an in-memory
// stand-in for findOne / findOneAndUpdate. Validation failures use the real model methods:
// Mongoose runs update validators before it needs a connection, so they reject right away.
const originals = {
  findOne: ShopProfile.findOne,
  findOneAndUpdate: ShopProfile.findOneAndUpdate,
};

test.afterEach(() => {
  ShopProfile.findOne = originals.findOne;
  ShopProfile.findOneAndUpdate = originals.findOneAndUpdate;
});

const useMemoryStore = () => {
  const store = { doc: null, writes: [] };
  ShopProfile.findOne = (filter) => ({
    lean: async () => (filter.key === "default" && store.doc ? { ...store.doc } : null),
  });
  ShopProfile.findOneAndUpdate = (filter, update, options) => ({
    lean: async () => {
      store.writes.push({ filter, update, options });
      const next = { ...(store.doc || { key: filter.key }), ...update.$set };
      Object.keys(update.$unset || {}).forEach((field) => delete next[field]);
      // Same schema validators the real update runs.
      await new ShopProfile(next).validate();
      store.doc = next;
      return { ...next };
    },
  });
  return store;
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

const put = (baseUrl, body) =>
  fetch(`${baseUrl}/api/shop-profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const EMPTY_PROFILE = {
  name: "",
  address: "",
  phones: [],
  logo: null,
  taxNumber: "",
  commercialRegister: "",
  invoiceFooter: "",
};

const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("GET before anything is saved returns empty defaults and writes nothing", async () => {
  const store = useMemoryStore();
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/shop-profile`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), EMPTY_PROFILE);
  });
  assert.equal(store.writes.length, 0);
});

test("PUT saves only the profile fields, upserts with validators, and GET returns them", async () => {
  const store = useMemoryStore();
  const profile = {
    name: "Smoke Shop",
    address: "10 Main Street",
    phones: ["01000000001", "01000000002"],
    logo: PNG_DATA_URI,
    taxNumber: "TAX-1",
    commercialRegister: "CR-1",
    invoiceFooter: "Thank you",
  };

  await withServer(async (baseUrl) => {
    const response = await put(baseUrl, { ...profile, key: "other", foo: "ignored", createdAt: "2000-01-01" });
    assert.equal(response.status, 200);
    const saved = await response.json();
    for (const [field, value] of Object.entries(profile)) assert.deepEqual(saved[field], value);

    assert.equal(store.writes.length, 1);
    const { filter, update, options } = store.writes[0];
    assert.deepEqual(filter, { key: "default" });
    assert.deepEqual(Object.keys(update), ["$set"]);
    assert.deepEqual(Object.keys(update.$set).sort(), Object.keys(profile).sort());
    assert.equal(options.upsert, true);
    assert.equal(options.runValidators, true);

    const reread = await fetch(`${baseUrl}/api/shop-profile`);
    assert.equal(reread.status, 200);
    const body = await reread.json();
    for (const [field, value] of Object.entries(profile)) assert.deepEqual(body[field], value);
  });
});

test("PUT replaces the profile: optional fields left out are cleared", async () => {
  const store = useMemoryStore();
  await withServer(async (baseUrl) => {
    await put(baseUrl, { name: "Shop", address: "Old address", taxNumber: "TAX-1", logo: PNG_DATA_URI });
    const response = await put(baseUrl, { name: "Shop", address: "", logo: null });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.name, "Shop");
    assert.equal(body.address, "");
    assert.equal(body.taxNumber, "");
    assert.equal(body.logo, null);
    assert.deepEqual(body.phones, []);
    assert.deepEqual(Object.keys(store.writes[1].update.$unset).sort(), [
      "address",
      "commercialRegister",
      "invoiceFooter",
      "logo",
      "taxNumber",
    ]);
  });
});

test("PUT rejects invalid profiles with 400", async () => {
  // Valid base64 (length is a multiple of 4) that decodes to just over 500 KB.
  const oversizedLogo = `data:image/png;base64,${"AAAA".repeat(Math.ceil((500 * 1024) / 3) + 1)}`;
  const cases = [
    ["missing name", { address: "No name" }, "اسم المتجر مطلوب"],
    ["blank name", { name: "   " }, "اسم المتجر مطلوب"],
    ["name over 150", { name: "n".repeat(151) }, "150"],
    ["more than 3 phones", { name: "Shop", phones: ["1", "2", "3", "4"] }, "3"],
    ["phone over 30", { name: "Shop", phones: ["1".repeat(31)] }, "30"],
    ["logo that is not a base64 image", { name: "Shop", logo: "not-an-image" }, "base64"],
    ["logo over 500 KB", { name: "Shop", logo: oversizedLogo }, "500"],
    ["tax number over 50", { name: "Shop", taxNumber: "t".repeat(51) }, "50"],
    ["commercial register over 50", { name: "Shop", commercialRegister: "c".repeat(51) }, "50"],
    ["address over 500", { name: "Shop", address: "a".repeat(501) }, "500"],
    ["invoice footer over 500", { name: "Shop", invoiceFooter: "f".repeat(501) }, "500"],
  ];

  await withServer(async (baseUrl) => {
    for (const [label, body, messagePart] of cases) {
      const response = await put(baseUrl, body);
      assert.equal(response.status, 400, label);
      const { message } = await response.json();
      assert.ok(message.includes(messagePart), `${label}: unexpected message "${message}"`);
    }
  });
});
