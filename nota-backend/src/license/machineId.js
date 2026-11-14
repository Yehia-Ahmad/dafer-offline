// Stage 24: this PC's Machine ID.
//   Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (read with `reg query`, no native module)
//   Linux (dev only): /etc/machine-id
// ID = first 16 hex chars of SHA-256("nota-machine-v1:" + guid), uppercase, shown as XXXX-XXXX-XXXX-XXXX.
const crypto = require("crypto");
const fs = require("fs");
const { execFileSync } = require("child_process");

const readWindowsGuid = () => {
  const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
    encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
  });
  const match = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
  if (!match) throw new Error("MachineGuid not found");
  return match[1];
};

const readLinuxGuid = () => fs.readFileSync("/etc/machine-id", "utf8").trim();

const idFromGuid = (guid) => {
  const hex = crypto.createHash("sha256").update(`nota-machine-v1:${guid}`).digest("hex").slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g).join("-");
};

let cached = null;

/** This PC's Machine ID, or null when it cannot be read (the license is then treated as invalid). */
const getMachineId = () => {
  if (cached) return cached;
  try {
    const guid = process.platform === "win32" ? readWindowsGuid() : readLinuxGuid();
    if (!guid) return null;
    cached = idFromGuid(guid);
  } catch {
    return null;
  }
  return cached;
};

module.exports = { getMachineId, idFromGuid };
