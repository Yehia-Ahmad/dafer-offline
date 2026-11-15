'use strict';

// Stage 25: the few facts about the database that go into the diagnostics file, read with the driver (no mongoose in the main process).
// Collection names come from the backend itself (nota-backend/src/models/collections.js, shipped in the driver bundle), never from a string typed here:
// a backend test checks that each model really uses the name listed there.

/**
 * @param {{ withClient: (callback: (db: any) => Promise<any>) => Promise<any>, collections: { META: string, AUDIT_LOG: string, DEVICE: string } }} deps
 * @returns {Promise<{ schemaVersion: number|null, appVersion: string|null, appBuild: string|null, migrations: Array<{version:number,name:string,at:string|null}>, pairedClients: number, knownClients: number }>}
 */
async function readDatabaseFacts({ withClient, collections }) {
  return withClient(async (db) => {
    const meta = await db.collection(collections.META).findOne({ _id: 'schema' }, { projection: { version: 1, appVersion: 1, appBuild: 1 } });
    const log = await db.collection(collections.AUDIT_LOG)
      .find({ action: 'system.migration' }, { projection: { at: 1, 'details.version': 1, 'details.name': 1 } })
      .sort({ at: 1 })
      .limit(200)
      .toArray();
    const pairedClients = await db.collection(collections.DEVICE).countDocuments({ role: 'client', paired: true });
    const knownClients = await db.collection(collections.DEVICE).countDocuments({ role: 'client' });
    return {
      schemaVersion: meta && typeof meta.version === 'number' ? meta.version : null,
      appVersion: meta ? meta.appVersion || null : null,
      appBuild: meta ? meta.appBuild || null : null,
      migrations: log.map((row) => ({ version: row.details && row.details.version, name: row.details && row.details.name, at: row.at ? new Date(row.at).toISOString() : null })),
      pairedClients,
      knownClients,
    };
  });
}

/** The accounting health report (GET /api/accounting/health) reduced to pass/fail and the numbers: no names, no ids. */
function summarizeHealth(raw) {
  if (!raw || typeof raw !== 'object') return { available: false, reason: 'no report' };
  const checks = {};
  let failed = 0;
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const numbers = {};
    for (const key of ['expected', 'actual', 'difference', 'unboxed', 'closes', 'unreversedEntries']) if (typeof value[key] === 'number') numbers[key] = value[key];
    if (Array.isArray(value.violations)) numbers.violations = value.violations.length;
    else if (typeof value.violations === 'number') numbers.violations = value.violations;
    const pass = (numbers.difference === undefined || numbers.difference === 0) && value.ok !== false && !numbers.violations;
    if (!pass) failed += 1;
    checks[name] = { pass, ...numbers };
  }
  return { available: true, allPass: failed === 0, failed, checks };
}

module.exports = { readDatabaseFacts, summarizeHealth };
