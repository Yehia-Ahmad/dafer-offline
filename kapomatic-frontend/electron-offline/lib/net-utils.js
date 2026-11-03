'use strict';

const net = require('node:net');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

// Sent to the lock port by `Kapomatic Offline.exe --quit-all` (the installer): the copy holding
// the lock, in whichever Windows account, stops cleanly.
const QUIT_COMMAND = 'KAPOMATIC_OFFLINE_QUIT_V1';

// Holding a local port is a machine-wide lock: unlike Electron's single-instance lock, it
// also sees copies of the app running under other Windows accounts, and Windows releases it
// automatically if the process dies. Resolves to the server, or null if another copy has it.
// onQuit is called when another process sends QUIT_COMMAND.
function holdPortLock(port, { host = '127.0.0.1', onQuit } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.setTimeout(2000, () => socket.destroy());
      socket.on('error', () => {});
      let text = '';
      socket.on('data', (chunk) => {
        text += chunk.toString('latin1');
        const end = text.indexOf('\n');
        if (end < 0) {
          if (text.length > 64) socket.destroy();
          return;
        }
        if (text.slice(0, end).trim() === QUIT_COMMAND && onQuit) {
          socket.end('OK\n');
          onQuit();
        } else {
          socket.destroy();
        }
      });
    });
    server.once('error', (error) => (error.code === 'EADDRINUSE' ? resolve(null) : reject(error)));
    server.once('listening', () => resolve(server));
    server.listen({ port, host, exclusive: true });
  });
}

// Resolves to true when the copy holding the lock accepted the quit request.
function requestQuit(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let reply = '';
    const finish = (accepted) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(3000, () => finish(false));
    socket.once('connect', () => socket.write(`${QUIT_COMMAND}\n`));
    socket.on('data', (chunk) => {
      reply += chunk.toString('latin1');
      if (reply.startsWith('OK')) finish(true);
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(reply.startsWith('OK')));
  });
}

async function waitFor(check, { timeoutMs, intervalMs = 500, isCancelled = () => false }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isCancelled()) return false;
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

module.exports = { QUIT_COMMAND, holdPortLock, isPortFree, requestQuit, sleep, waitFor };
