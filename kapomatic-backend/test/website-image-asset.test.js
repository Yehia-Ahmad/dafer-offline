process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const WebsiteImage = require("../src/models/websiteImage.model");
const {
  getWebsiteImageAsset,
  getActiveWebsiteImagesWithProducts,
} = require("../src/controllers/websiteImage.controller");
const {
  getPublicHomePage,
} = require("../src/controllers/publicPage.controller");
const GeneralSetting = require("../src/models/generalSetting.model");
const EcommerceSetting = require("../src/models/ecommerceSetting.model");
const errorHandler = require("../src/middlewares/error.middleware");
const {
  getWebsiteImageAssetUrl,
  clearPublicSeoCache,
} = require("../src/utils/seo");
const { decodeImage } = require("../src/utils/decodeImage");
const ID = "6a3ec0fdf89d31fbfaa73791";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
const JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==";
const chain = (value) => ({
  select() {
    return this;
  },
  sort() {
    return this;
  },
  lean() {
    return Promise.resolve(value);
  },
});

test("image route sends bytes, validates data, and stays available after errors", async (t) => {
  let record;
  t.mock.method(WebsiteImage, "findOne", (query) => {
    assert.deepEqual(query, { _id: ID, isActive: true });
    return chain(record);
  });
  const app = express();
  app.get("/api/website-images/:id/image", getWebsiteImageAsset);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/website-images/${ID}/image`;
  for (const [name, stored, mime, raw] of [
    ["JPEG data URL", `data:image/jpeg;base64,${JPEG}`, "image/jpeg", JPEG],
    ["PNG data URL", `data:image/png;base64,${PNG}`, "image/png", PNG],
    ["raw JPEG", JPEG, "image/jpeg", JPEG],
    ["raw PNG", PNG, "image/png", PNG],
    ["whitespace", `data:image/png;base64,\n${PNG}\n`, "image/png", PNG],
  ])
    await t.test(name, async () => {
      record = { imageBase64: stored };
      const response = await fetch(url);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), mime);
      assert.equal(
        Number(response.headers.get("content-length")),
        bytes.length,
      );
      assert.equal(
        response.headers.get("cache-control"),
        "public, max-age=3600",
      );
      assert.deepEqual(bytes, Buffer.from(raw, "base64"));
      const head = await fetch(url, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(Number(head.headers.get("content-length")), bytes.length);
    });
  for (const [value, status] of [
    [null, 404],
    [{}, 404],
    [{ imageBase64: "invalid!!!" }, 422],
    [{ imageBase64: 123 }, 422],
    [{ imageBase64: "aGVsbG8=" }, 422],
    [{ imageBase64: `data:image/jpeg;base64,${PNG}` }, 422],
  ]) {
    record = value;
    const response = await fetch(url);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok((await response.json()).message);
  }
  record = { imageBase64: PNG };
  assert.equal((await fetch(url)).status, 200);
});

test("rejects malformed padding and supports large stored images without recursive validation", () => {
  for (const input of [
    "a",
    "abcd===",
    "abc=def",
    "%%%%",
    {},
    "",
    "data:image/png;base64,",
  ]) {
    assert.throws(() => decodeImage(input), { statusCode: 422 });
  }
  const large = Buffer.concat([
    Buffer.from(JPEG, "base64"),
    Buffer.alloc(2_000_000),
  ]);
  assert.deepEqual(decodeImage(large.toString("base64")).buffer, large);
});

test("both public contracts use the configured canonical origin regardless of SSR host", async (t) => {
  const previous = process.env.PUBLIC_API_ORIGIN;
  t.after(() => {
    if (previous === undefined) delete process.env.PUBLIC_API_ORIGIN;
    else process.env.PUBLIC_API_ORIGIN = previous;
    clearPublicSeoCache();
  });
  const promotion = {
    _id: ID,
    isActive: true,
    viewOnly: true,
    title: "Offer",
    categoryIds: [],
    productIds: [],
  };
  t.mock.method(WebsiteImage, "find", () => chain([promotion]));
  t.mock.method(GeneralSetting, "findOne", () =>
    chain({ homePageCategoryIds: [] }),
  );
  t.mock.method(EcommerceSetting, "find", () => chain([]));
  const req = {
    query: { locale: "en", device: "desktop" },
    protocol: "http",
    get: () => "kapomatic.com",
  };
  const invoke = (handler) =>
    new Promise((resolve, reject) =>
      handler(
        req,
        {
          set() {
            return this;
          },
          json: resolve,
        },
        reject,
      ),
    );
  for (const origin of [
    "https://api.example.test",
    "https://api.example.test/api/",
  ]) {
    process.env.PUBLIC_API_ORIGIN = origin;
    clearPublicSeoCache();
    const home = await invoke(getPublicHomePage);
    const active = await invoke(getActiveWebsiteImagesWithProducts);
    const expected = `https://api.example.test/api/website-images/${ID}/image`;
    assert.equal(
      home.data.sections[0].settings.slides[0].desktopImage,
      expected,
    );
    assert.equal(
      home.data.sections[0].settings.slides[0].mobileImage,
      expected,
    );
    assert.equal(active[0].imageUrl, expected);
    assert.equal(JSON.stringify([home, active]).includes("base64"), false);
  }
  delete process.env.PUBLIC_API_ORIGIN;
  assert.equal(
    getWebsiteImageAssetUrl(req, ID),
    `https://api.kapomatic.com/api/website-images/${ID}/image`,
  );
  for (const origin of [
    "http://127.0.0.1:5000/api/",
    "http://localhost:4000",
    "http://[::1]:5000/api",
  ]) {
    process.env.PUBLIC_API_ORIGIN = origin;
    assert.equal(
      getWebsiteImageAssetUrl(req, ID),
      `https://api.kapomatic.com/api/website-images/${ID}/image`,
    );
  }
});

test("error middleware delegates after binary headers have been sent", () => {
  const error = new Error("connection failed");
  let delegated;
  errorHandler(error, {}, { headersSent: true }, (err) => {
    delegated = err;
  });
  assert.equal(delegated, error);
});
