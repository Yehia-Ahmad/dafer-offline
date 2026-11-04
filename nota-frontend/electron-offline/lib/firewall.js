'use strict';

// The installer (installer-offline/installer.nsh) adds two inbound Windows Firewall rules for
// the app: TCP for the backend, UDP for discovery, from the local subnet only. The app cannot
// add them itself (that needs administrator rights), so it only checks they are there.

const { execFile } = require('node:child_process');
const path = require('node:path');

const EDITION = require('../edition.json');

// Keep in sync with installer-offline/installer.nsh.
const FIREWALL_RULES = [`${EDITION.productName} Server`, `${EDITION.productName} Discovery`];

// netsh exits with 0 when a rule with that name exists and 1 when none does, whatever the
// Windows display language. Resolves to the missing rule names, or null if netsh did not run.
function missingFirewallRules({ systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  const netsh = path.join(systemRoot, 'System32', 'netsh.exe');
  const check = (name) =>
    new Promise((resolve) => {
      execFile(netsh, ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`], { windowsHide: true, timeout: 15000 }, (error) => {
        if (!error) resolve('present');
        else resolve(error.code === 1 ? 'missing' : 'unknown');
      });
    });
  return Promise.all(FIREWALL_RULES.map(check)).then((results) =>
    results.includes('unknown') ? null : FIREWALL_RULES.filter((_name, index) => results[index] === 'missing')
  );
}

module.exports = { FIREWALL_RULES, missingFirewallRules };
