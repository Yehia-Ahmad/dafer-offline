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

// ---- Another MongoDB on our port, and pids that are not ours -------------------------------

// Driver stand-in: the server answers serverStatus with `serverPid` (or throws `statusError`)
// and getCmdLineOpts with `dbPath`. state.down turns true once it was sent shutdown.
function fakeDriver({ serverPid = null, statusError = null, dbPath = null } = {}) {
  const commands = [];
  const state = { down: false };
  class MongoServerError extends Error {}
  class MongoClient {
    db() {
      return {
        command: async (command) => {
          const name = Object.keys(command)[0];
          commands.push(name);
          if (name === 'serverStatus') {
            if (statusError) throw statusError(MongoServerError);
            return { pid: serverPid };
          }
          if (name === 'getCmdLineOpts') return { argv: [], parsed: { storage: { dbPath } } };
          if (name === 'shutdown') state.down = true;
          return { ok: 1 };
        },
      };
    }
    async close() {}
  }
  return { mongodb: { MongoClient, MongoServerError }, commands, state };
}

const fakeManager = (mongodb, extra = {}) =>
  new MongodManager({
    mongodPath: path.join(os.tmpdir(), 'nota-not-installed', 'mongodb', 'bin', 'mongod.exe'),
    dbPath: 'unused',
    logFile: 'unused',
    pidFile: 'unused',
    port: 27399,
    mongodb,
    log: silentLog,
    ...extra,
  });

test('sendShutdown sends the command only to the server whose pid is ours', async () => {
  const foreign = fakeDriver({ serverPid: 4242 });
  assert.equal(await fakeManager(foreign.mongodb).sendShutdown(1111), 'foreign');
  assert.deepEqual(foreign.commands, ['serverStatus'], 'no shutdown sent to pid 4242');

  const locked = fakeDriver({ statusError: (ServerError) => new ServerError('command serverStatus requires authentication') });
  assert.equal(await fakeManager(locked.mongodb).sendShutdown(1111), 'foreign', 'a server that will not say its pid is not ours');
  assert.deepEqual(locked.commands, ['serverStatus']);

  const nobody = fakeDriver({ statusError: () => new Error('connect ECONNREFUSED 127.0.0.1:27399') });
  assert.equal(await fakeManager(nobody.mongodb).sendShutdown(1111), 'unreachable');
  assert.deepEqual(nobody.commands, ['serverStatus']);

  const ours = fakeDriver({ serverPid: 1111 });
  assert.equal(await fakeManager(ours.mongodb).sendShutdown(1111), 'sent');
  assert.deepEqual(ours.commands, ['serverStatus', 'shutdown']);
});

test('stopOrphan leaves a pid alone when its program is not our mongod.exe, and removes the stale pid file', async () => {
  const { spawn } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-orphan-'));
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const pidFile = path.join(home, 'mongod.pid');
    fs.writeFileSync(pidFile, String(bystander.pid));
    const driver = fakeDriver({ serverPid: bystander.pid }); // even a server reporting that pid gets nothing
    const asked = [];
    const manager = fakeManager(driver.mongodb, {
      pidFile,
      processImagePath: (pid) => {
        asked.push(pid);
        return path.join(os.tmpdir(), 'Other MongoDB', 'Server', '8.0', 'bin', 'mongod.exe');
      },
    });
    const startedAt = Date.now();
    await manager.stopOrphan();
    assert.ok(Date.now() - startedAt < 5000, 'no 30 s wait for the process to exit');
    assert.deepEqual(asked, [bystander.pid]);
    assert.deepEqual(driver.commands, [], 'nothing was sent to the database port');
    assert.equal(fs.existsSync(pidFile), false, 'stale pid file removed');
    assert.equal(bystander.exitCode, null, 'the process was not killed');
    assert.doesNotThrow(() => process.kill(bystander.pid, 0));
  } finally {
    bystander.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a server on our port running on our own data folder is our orphan: shut down cleanly, then the port frees', async () => {
  const dbPath = path.join(os.tmpdir(), 'nota-home', 'db');
  const driver = fakeDriver({ serverPid: 7777, dbPath }); // e.g. left over under another Windows account
  const portChecks = [];
  const manager = fakeManager(driver.mongodb, {
    dbPath,
    pidFile: path.join(os.tmpdir(), 'nota-no-such-dir', 'mongod.pid'), // no pid file
    isPortFree: async () => {
      portChecks.push(driver.state.down);
      return driver.state.down;
    },
  });
  await manager.stopOrphan();
  assert.deepEqual(driver.commands, ['serverStatus', 'getCmdLineOpts', 'serverStatus', 'shutdown']);
  assert.equal(driver.state.down, true);
  assert.deepEqual(portChecks, [false, true], 'waited until the port was free');
});

test('a server on our port with another data folder stays foreign: never shut down, start() refuses the port', async () => {
  const driver = fakeDriver({ serverPid: 7777, dbPath: path.join(os.tmpdir(), 'Other MongoDB', 'data') });
  const manager = fakeManager(driver.mongodb, {
    mongodPath: process.execPath, // exists, never started: the port check refuses first
    dbPath: path.join(os.tmpdir(), 'nota-home', 'db'),
    pidFile: path.join(os.tmpdir(), 'nota-no-such-dir', 'mongod.pid'),
    isPortFree: async () => false,
  });
  await assert.rejects(manager.start(), (error) => error.code === 'MONGOD_PORT_IN_USE');
  assert.deepEqual(driver.commands, ['serverStatus', 'getCmdLineOpts'], 'only asked who it is; no shutdown');
  assert.equal(driver.state.down, false);
  assert.equal(manager.child, null);
});

test('samePath: Windows ignores case, slash style and a trailing separator; other platforms compare exactly', () => {
  const { samePath } = require('../lib/mongod-manager');
  assert.equal(samePath('C:\\ProgramData\\Nota\\db', 'c:/programdata/nota/db', 'win32'), true);
  assert.equal(samePath('C:\\ProgramData\\Nota\\db', 'C:\\PROGRAMDATA\\Nota\\db\\', 'win32'), true);
  assert.equal(samePath('C:\\ProgramData\\Nota\\db', 'C:\\ProgramData\\Nota\\db2', 'win32'), false);
  assert.equal(samePath('C:\\ProgramData\\Nota\\db', 'D:\\ProgramData\\Nota\\db', 'win32'), false);
  assert.equal(samePath('/var/lib/nota/db', '/var/lib/nota/db/', 'linux'), true);
  assert.equal(samePath('/var/lib/nota/db', '/var/lib/Nota/db', 'linux'), false, 'case matters off Windows');
});

test('on Windows, a server whose dbPath differs from ours only in case or slashes is our orphan; another folder is not', async () => {
  const ours = 'C:\\ProgramData\\Nota\\db';
  const run = async (reportedDbPath) => {
    const driver = fakeDriver({ serverPid: 7777, dbPath: reportedDbPath });
    const manager = fakeManager(driver.mongodb, {
      platform: 'win32',
      dbPath: ours,
      pidFile: path.join(os.tmpdir(), 'nota-no-such-dir', 'mongod.pid'),
      isPortFree: async () => driver.state.down,
    });
    await manager.stopOrphan();
    return driver;
  };

  const sameFolder = await run('c:/programdata/nota/DB/');
  assert.equal(sameFolder.state.down, true, 'same folder written differently: shut down');
  assert.deepEqual(sameFolder.commands, ['serverStatus', 'getCmdLineOpts', 'serverStatus', 'shutdown']);

  const otherFolder = await run('c:/programdata/nota/db-other');
  assert.equal(otherFolder.state.down, false, 'another folder: left alone');
  assert.deepEqual(otherFolder.commands, ['serverStatus', 'getCmdLineOpts']);
});

test('processImagePath reads the full path of a running process', { skip: process.platform !== 'win32' }, () => {
  const { processImagePath } = require('../lib/mongod-manager');
  assert.equal(processImagePath(process.pid).toLowerCase(), process.execPath.toLowerCase());
  assert.equal(processImagePath(0), '');
});

test(
  'real mongod: another MongoDB on 0.0.0.0 of our port is refused, gets none of our data, and is never shut down',
  { skip: !canRun, timeout: 240000 },
  () =>
    withHome(async (home) => {
      const { spawn } = require('node:child_process');
      const mongodb = require(driverPath);
      const port = 27341;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // The "other MongoDB": the same mongod.exe under a different path (a hard link), so its
      // image name is mongod.exe too and only the full path tells it apart from ours.
      const otherBin = path.join(home, 'other-mongodb', 'bin');
      fs.mkdirSync(otherBin, { recursive: true });
      const otherExe = path.join(otherBin, 'mongod.exe');
      try {
        fs.linkSync(mongodPath, otherExe);
      } catch {
        fs.copyFileSync(mongodPath, otherExe);
      }
      const otherDb = path.join(home, 'other-db');
      fs.mkdirSync(otherDb);
      const otherLog = path.join(home, 'other.log');
      const other = spawn(
        otherExe,
        ['--dbpath', otherDb, '--port', String(port), '--bind_ip', '0.0.0.0', '--logpath', otherLog, '--wiredTigerCacheSizeGB', '0.25'],
        { stdio: 'ignore', windowsHide: true }
      );
      const otherAnswers = async () => {
        const client = new mongodb.MongoClient(`mongodb://127.0.0.1:${port}`, { directConnection: true, serverSelectionTimeoutMS: 3000 });
        try {
          const status = await client.db('admin').command({ serverStatus: 1 });
          const { databases } = await client.db('admin').admin().listDatabases();
          return { pid: status.pid, names: databases.map((db) => db.name) };
        } finally {
          await client.close();
        }
      };
      const otherReady = () => fs.existsSync(otherLog) && fs.readFileSync(otherLog, 'utf8').includes('Waiting for connections');

      try {
        for (let i = 0; i < 300 && !otherReady(); i++) await wait(200);
        assert.equal((await otherAnswers()).pid, other.pid, 'the other MongoDB is up');

        const options = {
          mongodPath,
          dbPath: path.join(home, 'db'),
          logFile: path.join(home, 'mongod.log'),
          pidFile: path.join(home, 'mongod.pid'),
          port,
          mongodb,
          log: silentLog,
        };

        // 1. The port check sees the 0.0.0.0 listener: refused before our mongod is started.
        const checked = new MongodManager(options);
        await assert.rejects(checked.start(), (error) => error.code === 'MONGOD_PORT_IN_USE');
        assert.equal(checked.child, null);
        assert.equal(fs.existsSync(options.pidFile), false, 'our mongod was never started');

        // 2. Even if the port check misses it, readiness counts only our own pid: the other
        //    server answering first is detected, our mongod is stopped, the start fails.
        const unchecked = new MongodManager({ ...options, isPortFree: async () => true });
        const startPromise = unchecked.start();
        for (let i = 0; i < 100 && !unchecked.child; i++) await wait(10);
        const ourPid = unchecked.child && unchecked.child.pid;
        await assert.rejects(startPromise, (error) => {
          assert.equal(error.code, 'MONGOD_PORT_IN_USE');
          assert.equal(error.message, `المنفذ ${port} الخاص بقاعدة البيانات مستخدم من برنامج آخر.`, 'same message as before');
          assert.match(error.detail, new RegExp(`pid ${other.pid}\\b`));
          return true;
        });
        assert.equal(unchecked.child, null);
        assert.ok(ourPid, 'our mongod had been started');
        assert.throws(() => process.kill(ourPid, 0), 'our mongod was stopped');
        assert.equal(fs.existsSync(options.pidFile), false, 'pid file removed');

        // 3. sendShutdown refuses the other server: its pid is not ours.
        assert.equal(await unchecked.sendShutdown(ourPid), 'foreign');

        // 4. A stale pid file naming the other mongod.exe (not our path): left alone, no wait.
        fs.writeFileSync(options.pidFile, String(other.pid));
        const startedAt = Date.now();
        await new MongodManager(options).stopOrphan();
        assert.ok(Date.now() - startedAt < 15000, 'no 30 s wait for a process that is not ours');
        assert.equal(fs.existsSync(options.pidFile), false, 'stale pid file removed');

        // The other MongoDB is still running, untouched, and never received our database.
        assert.equal(other.exitCode, null, 'the other MongoDB was not stopped');
        const after = await otherAnswers();
        assert.equal(after.pid, other.pid);
        assert.ok(!after.names.includes('nota'), `no "nota" database on the other MongoDB (has: ${after.names.join(', ')})`);
      } finally {
        if (other.exitCode === null) {
          other.kill();
          await new Promise((resolve) => other.once('exit', resolve));
        }
      }
    })
);
