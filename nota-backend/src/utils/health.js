const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

// Version shown by /health: release.json (written by deploy/make-release.js, next to the backend folder)
// when present, otherwise this package's own version.
const readVersion = (backendDir = path.join(__dirname, "..", "..")) => {
  try {
    const release = JSON.parse(fs.readFileSync(path.join(backendDir, "..", "release.json"), "utf8"));
    if (release && release.version) return String(release.version);
  } catch {
    // no release.json (development): fall through
  }
  try {
    return String(JSON.parse(fs.readFileSync(path.join(backendDir, "package.json"), "utf8")).version || "unknown");
  } catch {
    return "unknown";
  }
};

const pingDb = async () => {
  if (mongoose.connection.readyState !== 1) throw new Error("not connected");
  await mongoose.connection.db.admin().ping();
};

// GET /health: no auth, no other data. 200 when MongoDB answers a ping, 503 otherwise.
const createHealthHandler = ({ ping = pingDb, version = readVersion() } = {}) => async (req, res) => {
  try {
    await ping();
    res.status(200).json({ ok: true, version, db: "up" });
  } catch {
    res.status(503).json({ ok: false, version, db: "down" });
  }
};

module.exports = { createHealthHandler, readVersion, pingDb };
