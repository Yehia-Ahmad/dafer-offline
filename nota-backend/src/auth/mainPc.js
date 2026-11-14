// Stage 24: is this request the main PC itself?
//
// Loopback alone is not enough: any program on the main PC (or a TCP forwarder, a proxy) can relay a LAN request to 127.0.0.1.
// So the main PC is a request that comes over loopback AND carries the per-start secret that Electron main generates at every start,
// hands to the backend in its environment (NOTA_MAIN_TOKEN) and adds ONLY to its own windows' requests. The token is never logged and
// never written to disk by the backend (Electron main keeps a machine-scope DPAPI copy for attached sessions, lib/main-token-file.js). A loopback request without it is handled as a client PC (device id required, counts toward the limit).
//
// Without NOTA_MAIN_TOKEN (a plain `node src/server.js`) the backend makes a random token nobody knows: no request is "the main PC", so the
// license lock and the device check stay on. Tests read the token with mainPcToken().
const crypto = require("node:crypto");
const { isLoopback } = require("./middleware");

const { timingSafeEqual, randomBytes, createHash } = crypto;
const HEADER = "x-nota-main-token";

const configured = String(process.env.NOTA_MAIN_TOKEN || "");
const token = configured.length >= 16 ? configured : randomBytes(32).toString("hex");
delete process.env.NOTA_MAIN_TOKEN; // not visible to anything that reads the environment later

// Compare fixed-length digests, in constant time.
const digest = (value) => createHash("sha256").update(String(value)).digest();
const expected = digest(token);

const hasMainToken = (req) => {
  const sent = req.get(HEADER);
  return typeof sent === "string" && sent.length > 0 && timingSafeEqual(digest(sent), expected);
};

const isMainPc = (req) => isLoopback(req) && hasMainToken(req);

/** Tests only (the token is otherwise unknown to everything but Electron main). */
const mainPcToken = () => token;

module.exports = { HEADER, isMainPc, hasMainToken, mainPcToken };
