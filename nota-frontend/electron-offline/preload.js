'use strict';

// The only bridge between the pages (Angular app, status page, setup page) and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('notaDesktop', {
  // Read by Angular before it starts (src/app/core/runtime/runtime-config.ts).
  getRuntimeConfig: () => ipcRenderer.invoke('nota:runtime-config'),

  // Connection to the server, shown by Angular's connection overlay.
  getConnection: () => ipcRenderer.invoke('nota:connection'),
  onConnection: (callback) => subscribe('nota:connection', callback),
  retryConnection: () => ipcRenderer.invoke('nota:retry-connection'),
  changeServerAddress: () => ipcRenderer.invoke('nota:change-address'),

  // The tray asks Angular to open a page (e.g. /backup).
  onNavigate: (callback) => subscribe('nota:navigate', callback),

  // Backup page (main PC only). Each call resolves to { ok, value } or { ok: false, error };
  // value is null when the user cancelled the file dialog or the confirmation.
  // Stage 15: the first argument is the page's session token; the main process checks it with the
  // backend (backup.manage) before anything runs. restore also takes the user's password.
  backup: {
    create: (token) => ipcRenderer.invoke('backup:create', token),
    restore: (token, password) => ipcRenderer.invoke('backup:restore', token, password),
    showFile: (token, file) => ipcRenderer.invoke('backup:show-file', token, file),
    openFolder: (token) => ipcRenderer.invoke('backup:open-folder', token),
    onProgress: (callback) => subscribe('backup:progress', callback),
    // Daily backup: last backups, the extra copy folder, the "copy outside this PC" warning.
    status: (token) => ipcRenderer.invoke('backup:status', token),
    onStatus: (callback) => subscribe('backup:status', callback),
    chooseCopyFolder: (token) => ipcRenderer.invoke('backup:choose-copy-folder', token),
    clearCopyFolder: (token) => ipcRenderer.invoke('backup:clear-copy-folder', token),
  },

  // Stage 15: after a restore every window goes to the sign-in screen ({ reason: 'restored' }).
  onSessionReset: (callback) => subscribe('nota:session-reset', callback),
  // Stage 15 (main PC): other main PCs answering on the LAN: [{ instanceId, shopName, address, port }].
  getOtherMainPcs: () => ipcRenderer.invoke('nota:other-main'),
  onOtherMainPcs: (callback) => subscribe('nota:other-main', callback),

  // Status page.
  getStatus: () => ipcRenderer.invoke('nota:status'),
  onStatus: (callback) => subscribe('nota:status', callback),
  retry: () => ipcRenderer.invoke('nota:retry'),
  openLogs: () => ipcRenderer.invoke('nota:open-logs'),
  quit: () => ipcRenderer.invoke('nota:quit'),

  // Setup page. Every call resolves to { ok: true, value } or { ok: false, error: { message, field } }.
  setup: {
    info: () => ipcRenderer.invoke('setup:info'),
    generateSecret: () => ipcRenderer.invoke('setup:generate-secret'),
    checkPort: (port) => ipcRenderer.invoke('setup:check-port', port),
    pickBackup: () => ipcRenderer.invoke('setup:pick-backup'),
    discover: () => ipcRenderer.invoke('setup:discover'),
    // Stage 15: other main PCs on the LAN, checked before this PC becomes the main PC.
    otherMain: () => ipcRenderer.invoke('setup:other-main'),
    completeMain: (input) => ipcRenderer.invoke('setup:complete-main', input),
    completeClient: (input) => ipcRenderer.invoke('setup:complete-client', input),
    onProgress: (callback) => subscribe('setup:progress', callback),
  },
});
