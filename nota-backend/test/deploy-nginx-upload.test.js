// Online Stage 7C: an ad image is one request of at most 8 MB to POST /api/campaigns/<id>/publish/images. nginx must not refuse it
// (client_max_body_size is 1m by default in the template); no other location may catch that path with a smaller limit. A real
// `nginx -t` needs nginx, so this test resolves the location the way nginx does (exact, then the longest prefix; `^~` stops the regex
// search) on the template text.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const template = fs.readFileSync(path.join(__dirname, "..", "..", "deploy", "templates", "nginx-nota.conf.template"), "utf8");

const toBytes = (value) => {
  const match = /^(\d+)([kKmMgG]?)$/.exec(value);
  return Number(match[1]) * ({ "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()]);
};

// Every `location [modifier] uri {` with its own client_max_body_size (directly inside it, not in a nested location).
const locations = () => {
  const out = [];
  const re = /location\s+(=|\^~|~\*?)?\s*("[^"]+"|\S+)\s*\{/g;
  let m;
  while ((m = re.exec(template))) {
    let depth = 1; let at = re.lastIndex;
    while (depth > 0 && at < template.length) {
      if (template[at] === "{") depth += 1;
      else if (template[at] === "}") depth -= 1;
      at += 1;
    }
    const body = template.slice(re.lastIndex, at);
    const direct = body.replace(/location[^{]*\{[^}]*\}/g, "");
    const size = /client_max_body_size\s+(\S+);/.exec(direct);
    out.push({ modifier: m[1] || "", uri: m[2].replace(/"/g, ""), size: size ? size[1] : null });
  }
  return out;
};

const resolve = (uri) => {
  const all = locations();
  const exact = all.find((l) => l.modifier === "=" && l.uri === uri);
  if (exact) return exact;
  const prefixes = all.filter((l) => (l.modifier === "" || l.modifier === "^~") && uri.startsWith(l.uri)).sort((a, b) => b.uri.length - a.uri.length);
  const best = prefixes[0];
  if (best && best.modifier === "^~") return best;
  const regex = all.find((l) => l.modifier.startsWith("~") && new RegExp(l.uri, l.modifier === "~*" ? "i" : "").test(uri));
  return regex || best;
};

test("the image upload path is served by a location whose body limit is above 8 MB; the template default and the staff API limits are unchanged", () => {
  const found = resolve("/api/campaigns/6b00ade754775f472b0c3068/publish/images");
  assert.ok(found, "a location matches");
  assert.equal(found.uri, "/api/", "it is the staff API location");
  assert.ok(toBytes(found.size) > 8 * 1024 * 1024, `client_max_body_size ${found.size} must be above 8m`);
  assert.equal(toBytes(found.size), 100 * 1024 * 1024, "the existing staff API limit: no extra location was needed or added");
  assert.match(template, /client_max_body_size 1m;/, "the server-level default stays 1m");
  // the public customer API keeps its small limits
  assert.equal(resolve("/api/store/orders").size, "64k");
  assert.equal(resolve("/api/store/visits").size, "4k");
});
