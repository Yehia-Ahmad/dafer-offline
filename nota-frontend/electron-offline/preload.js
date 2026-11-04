'use strict';

// The only bridge between the pages (Angular app, status page, setup page) and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('kapomaticDesktop', {
  // Read by Angular before it starts (src/app/core/runtime/runtime-config.ts).
  getRuntimeConfig: () => ipcRenderer.invoke('kapomatic:runtime-config'),

  // Connection to the server, shown by Angular's connection overlay.
  getConnection: () => ipcRenderer.invoke('kapomatic:connection'),
  onConnection: (callback) => subscribe('kapomatic:connection', callback),
  retryConnection: () => ipcRenderer.invoke('kapomatic:retry-connection'),
  changeServerAddress: () => ipcRenderer.invoke('kapomatic:change-address'),

  // The tray asks Angular to open a page (e.g. /backup).
  onNavigate: (callback) => subscribe('kapomatic:navigate', callback),

  // Backup page (main PC only). Each call resolves to { ok, value } or { ok: false, error };
  // value is null when the user cancelled the file dialog or the confirmation.
  backup: {
    create: () => ipcRenderer.invoke('backup:create'),
    restore: () => ipcRenderer.invoke('backup:restore'),
    showFile: (file) => ipcRenderer.invoke('backup:show-file', file),
    openFolder: () => ipcRenderer.invoke('backup:open-folder'),
    onProgress: (callback) => subscribe('backup:progress', callback),
    // Daily backup: last backups, the extra copy folder, the "copy outside this PC" warning.
    status: () => ipcRenderer.invoke('backup:status'),
    onStatus: (callback) => subscribe('backup:status', callback),
    chooseCopyFolder: () => ipcRenderer.invoke('backup:choose-copy-folder'),
    clearCopyFolder: () => ipcRenderer.invoke('backup:clear-copy-folder'),
  },

  // Status page.
  getStatus: () => ipcRenderer.invoke('kapomatic:status'),
  onStatus: (callback) => subscribe('kapomatic:status', callback),
  retry: () => ipcRenderer.invoke('kapomatic:retry'),
  openLogs: () => ipcRenderer.invoke('kapomatic:open-logs'),
  quit: () => ipcRenderer.invoke('kapomatic:quit'),

  // Setup page. Every call resolves to { ok: true, value } or { ok: false, error: { message, field } }.
  setup: {
    info: () => ipcRenderer.invoke('setup:info'),
    generateSecret: () => ipcRenderer.invoke('setup:generate-secret'),
    checkPort: (port) => ipcRenderer.invoke('setup:check-port', port),
    pickBackup: () => ipcRenderer.invoke('setup:pick-backup'),
    discover: () => ipcRenderer.invoke('setup:discover'),
    completeMain: (input) => ipcRenderer.invoke('setup:complete-main', input),
    completeClient: (input) => ipcRenderer.invoke('setup:complete-client', input),
    onProgress: (callback) => subscribe('setup:progress', callback),
  },
});
