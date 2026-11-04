'use strict';

// Runs the real bundled mongod.exe when it is available (npm run offline:vendor), in plain
// Node with the backend's MongoDB driver.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MongodManager, explainMongodExit } = require('../lib/mongod-manager');
const { resolveResources } = require('../lib/paths');

const resources = resolveResources({ isPackaged: false });
const mongodPath = path.join(resources.mongodbBin, 'mongod.exe');
const driverPath = path.join(resources.backendDir, 'node_modules', 'mongodb');
const canRun = process.platform === 'win32' && fs.existsSync(mongodPath) && fs.existsSync(driverPath);
const silentLog = { info() {}, warn() {}, error() {} };

// Every mongod a test starts is killed afterwards, even when the test fails, so a failure
// can never leave a process running that keeps the test runner alive.
async function withHome(callback) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-mongod-'));
  const managers = [];
  const track = (manager) => {
    managers.push(manager);
    return manager;
  };
  try {
    await callback(home, track);
  } finally {
    for (const manager of managers) {
      if (manager.child) {
        manager.stopping = true;
        manager.child.kill();
        await manager.exited;
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('mongod exit codes become clear Arabic errors', () => {
  assert.equal(explainMongodExit(0xc000001d).code, 'CPU_UNSUPPORTED');
  assert.equal(explainMongodExit(-1073741795).code, 'CPU_UNSUPPORTED', 'signed form of the same status');
  assert.equal(explainMongodExit(0xc0000135).code, 'RUNTIME_MISSING');
  assert.equal(explainMongodExit(100, '... "DBPathInUse" ...').code, 'DATA_IN_USE');
  const generic = explainMongodExit(14, 'line 1\nline 2');
  assert.equal(generic.code, 'MONGOD_FAILED');
  assert.match(generic.message, /14/);
});

test('real mongod: start, write, clean stop, and recovery from an orphan', { skip: !canRun, timeout: 180000 }, () =>
  withHome(async (home, track) => {
    const mongodb = require(driverPath);
    const options = {
      mongodPath,
      dbPath: path.join(home, 'db'),
      logFile: path.join(home, 'mongod.log'),
      pidFile: path.join(home, 'mongod.pid'),
      port: 27317,
      mongodb,
      log: silentLog,
    };

    // First run, as if the app crashed afterwards: its manager is abandoned with mongod running.
    const crashed = track(new MongodManager(options));
    await crashed.start();
    const orphanPid = Number(fs.readFileSync(options.pidFile, 'utf8'));
    const client = new mongodb.MongoClient(crashed.uri, { directConnection: true });
    await client.db().collection('smoke').insertOne({ ok: true });
    await client.close();

    // Next app start: must shut the orphan down cleanly, then start its own mongod.
    const manager = track(new MongodManager(options));
    await manager.start();
    await crashed.exited;
    assert.throws(() => process.kill(orphanPid, 0), 'the orphan is gone');
    assert.equal(
      Number(fs.readFileSync(options.pidFile, 'utf8')),
      manager.child.pid,
      'the pid file names the new mongod, even after the old one exited'
    );

    const check = new mongodb.MongoClient(manager.uri, { directConnection: true });
    assert.equal(await check.db().collection('smoke').countDocuments(), 1, 'data survived');
    await check.close();

    await manager.stop();
    assert.equal(fs.existsSync(options.pidFile), false);
    const logText = fs.readFileSync(options.logFile, 'utf8');
    assert.equal((logText.match(/"msg":"Now exiting"/g) || []).length, 2, 'both mongod runs shut down cleanly');
    assert.ok(!logText.includes('"Startup from clean shutdown?":false'), 'no unclean-shutdown recovery was needed');
  })
);

test('real mongod: a second copy on the same data folder is refused with DATA_IN_USE', { skip: !canRun, timeout: 180000 }, () =>
  withHome(async (home, track) => {
    const mongodb = require(driverPath);
    const base = { mongodPath, dbPath: path.join(home, 'db'), mongodb, log: silentLog };
    const first = track(
      new MongodManager({ ...base, logFile: path.join(home, 'a.log'), pidFile: path.join(home, 'a.pid'), port: 27319 })
    );
    await first.start();

    const second = track(
      new MongodManager({ ...base, logFile: path.join(home, 'b.log'), pidFile: path.join(home, 'b.pid'), port: 27320 })
    );
    await assert.rejects(second.start(), (error) => error.code === 'DATA_IN_USE');
    await first.stop();
  })
);
