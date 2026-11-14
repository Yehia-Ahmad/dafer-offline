'use strict';

// Stage 24: the main process's own license check, for the UI (the activation screen instead of the app).
// The backend check is the real lock; this one only decides what the window shows.
//
// It does not carry a second copy of the key: it loads the backend's own license module (resources/backend/src/license),
// the same way main already loads the mongodb driver from there. NOTA_LICENSE_DIR points both at <home>/license.

const fs = require('node:fs');

const MAX_LICENSE_BYTES = 8192; // a license is about 400 bytes; refuse anything absurd before reading it all

function createLicenseGate({ licenseDir, loadModule, log }) {
  let license = null;
  const module_ = () => {
    if (!license) {
      process.env.NOTA_LICENSE_DIR = licenseDir;
      license = loadModule();
    }
    return license;
  };

  const view = () => {
    const summary = module_().summary();
    return {
      licensed: summary.licensed === true,
      code: summary.code || null,
      machineId: summary.machineId || null,
      shopName: summary.shopName || null,
      shopNameEn: summary.shopNameEn || null,
    };
  };

  return {
    /** Re-reads and verifies the license file. { licensed, code, machineId, shopName, shopNameEn } */
    status() {
      module_().reload();
      return view();
    },

    /** Verifies and installs pasted license text. { ok: true, ...status } or { ok: false, code } */
    activate(text) {
      if (typeof text !== 'string' || text.length > MAX_LICENSE_BYTES) return { ok: false, code: 'MALFORMED' };
      const result = module_().install(text);
      if (!result.ok) {
        if (log) log.warn(`license refused: ${result.code}`);
        return { ok: false, code: result.code };
      }
      if (log) log.info(`license activated: ${result.payload.licenseId}`);
      return { ok: true, ...view() };
    },

    /** Same, from a nota.lic file the user picked. */
    activateFile(file) {
      let text;
      try {
        if (fs.statSync(file).size > MAX_LICENSE_BYTES) return { ok: false, code: 'MALFORMED' };
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return { ok: false, code: 'UNREADABLE' };
      }
      return this.activate(text.trim());
    },
  };
}

module.exports = { createLicenseGate, MAX_LICENSE_BYTES };
