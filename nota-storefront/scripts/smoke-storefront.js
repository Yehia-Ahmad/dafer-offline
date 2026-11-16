// Smoke test: builds the storefront (unless --no-build), starts a throwaway mongod and the real backend with seed data, starts the
// built SSR server against it and fetches the pages with fetch(), checking status codes and that the server-rendered HTML holds
// the product names, SEO tags, redirects, sitemap, robots, closed website and an unreachable API. Leaves no process behind.
//
//   node scripts/smoke-storefront.js [--no-build]
//
// Uses the backend's own test helpers (a bundled mongod: set NOTA_TEST_MONGOD to its path when it is not on PATH) and Node 24.
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "smoke-staff-secret-0123456789abcdef-0123456789abcdef";
process.env.NOTA_STORE_JWT_SECRET = "smoke-store-secret-0123456789abcdef-0123456789abcdef";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const root = path.join(__dirname, "..");
const backend = path.join(root, "..", "nota-backend");
const MONGO_PORT = 27126;
const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const children = [];
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  server.on("error", reject);
});

const results = [];
const check = (name, fn) => results.push({ name, fn });

async function startStorefront({ api, port, extraEnv = {} }) {
  const child = spawn(process.execPath, [path.join(root, "dist", "nota-storefront", "server", "server.mjs")], {
    env: { ...process.env, NOTA_STOREFRONT_PORT: String(port), NOTA_API_INTERNAL: api, NOTA_PUBLIC_URL: `http://localhost:${port}`, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return { child, base: `http://127.0.0.1:${port}`, log: () => log }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`storefront did not start:\n${log}`);
}

const get = async (url, init = {}) => {
  const response = await fetch(url, { redirect: "manual", ...init });
  return { status: response.status, headers: response.headers, text: await response.text() };
};

async function main() {
  if (!process.argv.includes("--no-build")) {
    const build = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["ng", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (build.status !== 0) throw new Error("storefront build failed");
  }

  const app = require(path.join(backend, "src", "app"));
  const { startMongod, clearDatabase, mongodSkipReason } = require(path.join(backend, "test", "helpers", "mongod"));
  if (mongodSkipReason) throw new Error(`no mongod: ${mongodSkipReason}`);
  const stopMongod = await startMongod({ port: MONGO_PORT });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, route, token, body) => {
    const r = await fetch(`${apiUrl}${route}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    assert.ok(r.status < 300, `${method} ${route} -> ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };

  try {
    await clearDatabase();
    await require(path.join(backend, "src", "auth", "ownerAccount")).createOwner({ name: "Owner", username: "smoke", password: "owner-pass-123" });
    const { token } = await call("POST", "/api/auth/login", null, { username: "smoke", password: "owner-pass-123" });
    const category = await call("POST", "/api/categories", token, { name: "أدوات كهربائية", image: PNG_URI });
    const categoryId = category._id || category.id;
    await call("PUT", `/api/website/categories/${categoryId}`, token, { visibility: "show", sortOrder: 1 });
    const seed = async (name, code, price, stock, discount = 0) => {
      const p = await call("POST", "/api/products", token, { name, code, categoryId, inventoryCount: stock, purchasePrice: 50, wholesalePrice: 60, retailPrice: price, ...(discount ? { discountPercentage: discount } : {}), image: PNG_URI, specifications: [{ label: "القدرة", value: "١٨ وات" }] });
      const id = p._id || p.product?._id;
      await call("PUT", `/api/website/products/${id}`, token, { visibility: "show", description: `وصف ${name}`, images: [PNG_URI] });
      return id;
    };
    const lamp = await seed("لمبة ليد ١٨ وات", "L1", 100, 40, 20);
    await seed("مشترك ٥ مخارج", "L2", 250, 10);
    await seed("كشاف نافد", "L3", 80, 0);
    await call("POST", "/api/website/delivery-zones", token, { name: "حي الجامعة", fee: 30, estimatedTime: "نفس اليوم" });
    const settingsBody = { enabled: true, orderingEnabled: true, title: "النور للأدوات الكهربائية", about: "كل اللي بيتك محتاجه", seoDescription: "متجر أدوات كهربائية في المنصورة", announcement: { enabled: true, text: "توصيل لكل الأحياء" }, returnsPolicy: "الاستبدال خلال ١٤ يوم", brandColor: "#7C2D12", closedMessage: "رجعنالكم قريب" };
    await call("PUT", "/api/website/settings", token, settingsBody);
    const lampProduct = await (await fetch(`${apiUrl}/api/store/products/${lamp}`)).json();
    const slug = encodeURIComponent(lampProduct.slug);

    const port = await freePort();
    const open = await startStorefront({ api: apiUrl, port });
    const B = open.base;

    check("/health answers without the backend", async () => { const r = await get(`${B}/health`); assert.equal(r.status, 200); assert.match(r.text, /"ok":true/); });
    check("home: 200, Arabic RTL, product names, brand colour, title and description in the server HTML", async () => {
      const r = await get(`${B}/`);
      assert.equal(r.status, 200);
      for (const text of ['lang="ar"', 'dir="rtl"', "لمبة ليد ١٨ وات", "مشترك ٥ مخارج", "أدوات كهربائية", "توصيل لكل الأحياء", "#7C2D12", "<title>"]) assert.ok(r.text.includes(text), `home lacks ${text}`);
      assert.match(r.text, /<meta name="description" content="[^"]+"/);
      assert.match(r.text, /<link rel="canonical" href="http:\/\/localhost:\d+\/"/);
    });
    check("category: 200 with the products; a wrong slug is a real 301 to the right one", async () => {
      const correct = `/c/${categoryId}/${encodeURIComponent("أدوات-كهربائية")}`;
      const r = await get(`${B}${correct}`);
      assert.equal(r.status, 200); assert.ok(r.text.includes("لمبة ليد ١٨ وات"));
      const wrong = await get(`${B}/c/${categoryId}/wrong-slug`);
      assert.equal(wrong.status, 301); assert.equal(decodeURIComponent(wrong.headers.get("location")), `/c/${categoryId}/أدوات-كهربائية`);
    });
    check("product: 200, name in HTML, JSON-LD Product (EGP), Open Graph image, canonical; wrong slug 301; unknown id 404", async () => {
      const r = await get(`${B}/p/${lamp}/${slug}`);
      assert.equal(r.status, 200);
      assert.ok(r.text.includes("لمبة ليد ١٨ وات"));
      assert.ok(r.text.includes("القدرة"), "specifications");
      const ld = /<script type="application\/ld\+json" data-nota-jsonld[^>]*>([^<]+)<\/script>/.exec(r.text);
      assert.ok(ld, "JSON-LD present");
      const data = JSON.parse(ld[1]);
      assert.equal(data["@type"], "Product"); assert.equal(data.offers.priceCurrency, "EGP"); assert.equal(data.offers.price, 80); assert.equal(data.offers.availability, "https://schema.org/InStock");
      assert.match(r.text, /<meta property="og:image" content="http:\/\/localhost:\d+\/api\/store\/images\/product\//);
      assert.match(r.text, new RegExp(`<link rel="canonical" href="http://localhost:\\d+/p/${lamp}/`));
      const wrong = await get(`${B}/p/${lamp}/not-the-slug`);
      assert.equal(wrong.status, 301); assert.equal(wrong.headers.get("location"), `/p/${lamp}/${slug}`);
      const missing = await get(`${B}/p/000000000000000000000000/x`);
      assert.equal(missing.status, 404);
    });
    check("sitemap.xml lists home, the category and the products; robots.txt disallows the private paths", async () => {
      const s = await get(`${B}/sitemap.xml`);
      assert.equal(s.status, 200); assert.match(s.headers.get("content-type"), /xml/);
      assert.ok(s.text.includes(`/p/${lamp}/${slug}`)); assert.ok(s.text.includes(`/c/${categoryId}/`)); assert.ok(s.text.includes("<loc>http://localhost:"));
      const r = await get(`${B}/robots.txt`);
      assert.equal(r.status, 200);
      for (const line of ["Disallow: /cart", "Disallow: /checkout", "Disallow: /account", "Disallow: /order/", "Disallow: /admin/", "Sitemap: http://localhost:"]) assert.ok(r.text.includes(line), `robots lacks ${line}`);
    });
    check("policy page is server-rendered; private pages are noindex; unknown path is a real 404", async () => {
      const p = await get(`${B}/policies/returns`);
      assert.equal(p.status, 200); assert.ok(p.text.includes("الاستبدال خلال ١٤ يوم"));
      const cart = await get(`${B}/cart`);
      assert.equal(cart.status, 200); assert.match(cart.headers.get("x-robots-tag") || "", /noindex/);
      assert.match((await get(`${B}/order/sometoken`)).headers.get("referrer-policy") || "", /no-referrer/);
      assert.equal((await get(`${B}/no/such/page`)).status, 404);
    });
    check("search and the delivery page render", async () => {
      assert.equal((await get(`${B}/search?q=${encodeURIComponent("لمبة")}`)).status, 200);
      const d = await get(`${B}/delivery`);
      assert.equal(d.status, 200); assert.ok(d.text.includes("حي الجامعة"));
    });

    let failed = 0;
    let total = 0;
    const runAll = async () => {
      total += results.length;
      for (const { name, fn } of results.splice(0)) {
        try { await fn(); console.log(`ok   ${name}`); } catch (error) { failed += 1; console.log(`FAIL ${name}
     ${error && error.message}
     storefront log: ${open.log().slice(-600)}`); }
      }
    };
    await runAll();

    // --keep: leave the seeded backend and storefront running (for Lighthouse or a look in the browser) until Ctrl+C / SIGTERM.
    if (process.argv.includes("--keep")) {
      console.log(`KEEP api=${apiUrl} storefront=${B} product=${B}/p/${lamp}/${slug} category=${B}/c/${categoryId}/${encodeURIComponent("أدوات-كهربائية")}`);
      await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
      return;
    }

    // closed website: a fresh process (the server caches settings for 30 s)
    await call("PUT", "/api/website/settings", token, { ...settingsBody, enabled: false });
    const closed = await startStorefront({ api: apiUrl, port: await freePort() });
    check("closed website: 503 + X-Nota-Closed with the closed message; the sitemap is closed too", async () => {
      const r = await get(`${closed.base}/`);
      assert.equal(r.status, 503); assert.equal(r.headers.get("x-nota-closed"), "1"); assert.ok(r.text.includes("رجعنالكم قريب"));
      assert.equal((await get(`${closed.base}/sitemap.xml`)).status, 503);
      assert.equal((await get(`${closed.base}/health`)).status, 200);
    });

    // backend unreachable
    const down = await startStorefront({ api: "http://127.0.0.1:1", port: await freePort() });
    check("API unreachable: 503 page (no stack trace), the process stays up, /health still 200", async () => {
      const r = await get(`${down.base}/`);
      assert.equal(r.status, 503); assert.ok(!/at \w+ \(/.test(r.text), "no stack trace");
      assert.equal((await get(`${down.base}/health`)).status, 200);
    });

    await runAll();
    console.log(failed ? `\n${failed} of ${total} smoke checks FAILED` : `\nall ${total} smoke checks passed`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    for (const child of children) { try { child.kill(); } catch { /* gone */ } }
    await new Promise((resolve) => server.close(resolve));
    await stopMongod();
  }
}

main().then(() => process.exit(process.exitCode || 0), (error) => { console.error(error); for (const c of children) { try { c.kill(); } catch { /* gone */ } } process.exit(1); });
