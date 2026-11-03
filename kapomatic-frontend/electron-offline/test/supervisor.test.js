'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { MainPcSupervisor } = require('../lib/supervisor');

const silentLog = { info() {}, warn() {}, error() {} };

class FakeService extends EventEmitter {
  constructor(name, calls) {
    super();
    this.name = name;
    this.calls = calls;
    this.running = false;
    this.failStarts = 0;
  }
  async start() {
    this.calls.push(`${this.name}.start`);
    if (this.failStarts > 0) {
      this.failStarts -= 1;
      const error = new Error(`${this.name} failed`);
      error.code = 'FAKE_FAIL';
      throw error;
    }
    this.running = true;
  }
  async stop() {
    this.calls.push(`${this.name}.stop`);
    this.running = false;
  }
  crash() {
    this.running = false;
    this.emit('exit', 1);
  }
}

// Timers that run only when the test says so.
function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
    async runNext() {
      const timer = pending.shift();
      timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
      return timer.ms;
    },
  };
}

function setup({ now = () => 0 } = {}) {
  const calls = [];
  const mongod = new FakeService('mongod', calls);
  const backend = new FakeService('backend', calls);
  const timers = manualTimers();
  const statuses = [];
  const supervisor = new MainPcSupervisor({
    mongod,
    backend,
    log: silentLog,
    restartDelaysMs: [10, 20, 30],
    stableAfterMs: 1000,
    timers,
    now,
  });
  supervisor.on('status', (status) => statuses.push(status.state));
  return { calls, mongod, backend, timers, statuses, supervisor };
}

test('starts mongod before the backend and stops in reverse order', async () => {
  const { calls, statuses, supervisor } = setup();
  await supervisor.start();
  await supervisor.stop();
  assert.deepEqual(calls, ['mongod.start', 'backend.start', 'backend.stop', 'mongod.stop']);
  assert.deepEqual(statuses, ['starting', 'running', 'stopping', 'stopped']);
});

test('a failed start reports failed and stops whatever started', async () => {
  const { calls, backend, supervisor } = setup();
  backend.failStarts = 1;
  await supervisor.start();
  assert.equal(supervisor.status.state, 'failed');
  assert.equal(supervisor.status.code, 'FAKE_FAIL');
  assert.deepEqual(calls, ['mongod.start', 'backend.start', 'backend.stop', 'mongod.stop']);
});

test('a crashed service is restarted after the first delay', async () => {
  const { calls, backend, timers, supervisor } = setup();
  await supervisor.start();
  calls.length = 0;

  backend.crash();
  assert.equal(supervisor.status.state, 'restarting');
  assert.equal(await timers.runNext(), 10);
  assert.deepEqual(calls, ['backend.start']);
  assert.equal(supervisor.status.state, 'running');
});

test('a mongod crash restarts only mongod', async () => {
  const { calls, mongod, timers, supervisor } = setup();
  await supervisor.start();
  calls.length = 0;

  mongod.crash();
  await timers.runNext();
  assert.deepEqual(calls, ['mongod.start']);
});

test('restart delays grow and the supervisor gives up after the last one', async () => {
  const { backend, timers, supervisor } = setup();
  await supervisor.start();

  backend.failStarts = 10;
  backend.crash();
  const delays = [];
  while (timers.pending.length) delays.push(await timers.runNext());

  assert.deepEqual(delays, [10, 20, 30]);
  assert.equal(supervisor.status.state, 'failed');
  assert.equal(supervisor.status.code, 'RESTART_LIMIT');
});

test('failed restarts do not reset the delays even long after the last healthy run', async () => {
  let clock = 0;
  const { backend, timers, supervisor } = setup({ now: () => clock });
  await supervisor.start();

  clock = 60000; // far beyond stableAfterMs
  backend.failStarts = 10;
  backend.crash();
  let rounds = 0;
  while (timers.pending.length && rounds < 10) {
    clock += 60000;
    await timers.runNext();
    rounds += 1;
  }
  assert.equal(supervisor.status.state, 'failed', 'it must give up instead of retrying forever');
  assert.equal(rounds, 3);
});

test('a crash after a long healthy run starts the delays over', async () => {
  let clock = 0;
  const { backend, timers, supervisor } = setup({ now: () => clock });
  await supervisor.start();

  backend.crash();
  assert.equal(await timers.runNext(), 10);
  backend.crash();
  assert.equal(await timers.runNext(), 20);

  clock = 5000; // healthy for longer than stableAfterMs
  backend.crash();
  assert.equal(await timers.runNext(), 10);
});

test('no restart is scheduled while stopping', async () => {
  const { backend, timers, supervisor } = setup();
  await supervisor.start();
  const stopping = supervisor.stop();
  backend.crash();
  await stopping;
  assert.equal(timers.pending.length, 0);
  assert.equal(supervisor.status.state, 'stopped');
});

test('retry after failure starts again from scratch', async () => {
  const { mongod, supervisor } = setup();
  mongod.failStarts = 1;
  await supervisor.start();
  assert.equal(supervisor.status.state, 'failed');
  await supervisor.start();
  assert.equal(supervisor.status.state, 'running');
});

test('maintenance stops only the backend, runs the task, then starts the backend again', async () => {
  const { calls, statuses, supervisor } = setup();
  await supervisor.start();
  calls.length = 0;
  statuses.length = 0;

  const result = await supervisor.runMaintenance(async () => {
    calls.push('task');
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(calls, ['backend.stop', 'task', 'backend.start']);
  assert.deepEqual(statuses, ['maintenance', 'running']);
});

test('maintenance reports why the server is paused', async () => {
  const { supervisor } = setup();
  await supervisor.start();
  const reasons = [];
  supervisor.on('status', (status) => status.state === 'maintenance' && reasons.push(status.reason));
  await supervisor.runMaintenance(async () => {}, { reason: 'auto-backup' });
  await supervisor.runMaintenance(async () => {});
  assert.deepEqual(reasons, ['auto-backup', 'restore']);

  const { statusLabel } = require('../lib/status-text');
  assert.match(statusLabel({ state: 'maintenance', reason: 'auto-backup' }), /اليومية/);
  assert.match(statusLabel({ state: 'maintenance', reason: 'backup' }), /نسخة احتياطية/);
  assert.match(statusLabel({ state: 'maintenance' }), /استعادة/);
});

test('a failed maintenance task still brings the server back', async () => {
  const { calls, supervisor } = setup();
  await supervisor.start();
  calls.length = 0;
  await assert.rejects(supervisor.runMaintenance(async () => { throw new Error('restore failed'); }), /restore failed/);
  assert.deepEqual(calls, ['backend.stop', 'backend.start']);
  assert.equal(supervisor.status.state, 'running');
});

test('maintenance is refused unless the server runs, and only one at a time', async () => {
  const { supervisor } = setup();
  await assert.rejects(supervisor.runMaintenance(async () => {}), (error) => error.code === 'SERVER_BUSY');
  await supervisor.start();
  let release;
  const first = supervisor.runMaintenance(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(supervisor.runMaintenance(async () => {}), (error) => error.code === 'SERVER_BUSY');
  release();
  await first;
});

test('a mongod crash during maintenance does not trigger the restart timer; mongod comes back afterwards', async () => {
  const { calls, mongod, timers, supervisor } = setup();
  await supervisor.start();
  calls.length = 0;
  await supervisor.runMaintenance(async () => {
    mongod.crash();
  });
  assert.equal(timers.pending.length, 0);
  assert.deepEqual(calls, ['backend.stop', 'mongod.start', 'backend.start']);
  assert.equal(supervisor.status.state, 'running');
});

test('quitting during maintenance waits for it and does not restart the backend', async () => {
  const { calls, supervisor } = setup();
  await supervisor.start();
  calls.length = 0;
  let release;
  const maintenance = supervisor.runMaintenance(() => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = supervisor.stop();
  release();
  await maintenance;
  await stopping;
  assert.deepEqual(calls, ['backend.stop', 'backend.stop', 'mongod.stop']);
  assert.equal(supervisor.status.state, 'stopped');
});
