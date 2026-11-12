'use strict';

// Nota (offline edition): Electron entry point.
//
// First launch: the setup page chooses the role.
// Main PC: runs the bundled mongod (127.0.0.1 only) and the Nota backend (LAN), answers LAN
// discovery, shows the admin app, and keeps the server running in the tray.
// Client PC: shows the admin app against the main PC's backend and watches the connection.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  powerSaveBlocker,
  session,
  shell,
  utilityProcess,
} = require('electron');

const EDITION = require('./edition.json');
const { ensureLayout, layout, resolveHome, resolveResources } = require('./lib/paths');
const { createLogger } = require('./lib/logger');
const { MONGOD_PORT, SERVER_LOCK_PORT, readConfig, writeConfig } = require('./lib/config-store');
const { protectSecret, unprotectSecret } = require('./lib/secret-store');
const { loadJwtSecret } = require('./lib/jwt-secret');
const { holdPortLock, isPortFree, requestQuit, waitFor } = require('./lib/net-utils');
const { MongodManager, ServiceError } = require('./lib/mongod-manager');
const { BackendManager, buildBackendEnv } = require('./lib/backend-manager');
const { MainPcSupervisor } = require('./lib/supervisor');
const { LAN_KEY_HEADER, installSecretHeader } = require('./lib/lan-auth');
const { statusLabel } = require('./lib/status-text');
const { DiscoveryResponder, discoverServers, localIPv4Addresses } = require('./lib/discovery');
const { ConnectionMonitor, probeServer } = require('./lib/client-link');
const { SetupController, SetupError } = require('./lib/setup-controller');
const { BackupService, backupFileName } = require('./lib/backup-service');
const { AutoBackup, onSameDrive } = require('./lib/auto-backup');
const { missingFirewallRules } = require('./lib/firewall');
const { createBackendClient } = require('./lib/ipc-guard');
const { createBackupHandlers } = require('./lib/backup-handlers');
const { createPrintService } = require('./lib/print-service');
const { createPrintHandlers } = require('./lib/print-handlers');
const { AUDIT_INBOX_NAME, appendAuditEntry } = require('./lib/audit-inbox');
const { MainPcWatcher } = require('./lib/main-pc-watcher');

const SHUTDOWN_WATCHDOG_MS = 90000;
const ATTACH_TIMEOUT_MS = 30000;
// --quit-all waits this long for the server to stop (a little more than the shutdown watchdog).
const QUIT_ALL_TIMEOUT_MS = 100000;

// Per-user Chromium data (UI language, theme). Shared data lives in the home folder instead.
app.setName(EDITION.productName);
app.setPath(
  'userData',
  process.env.NOTA_OFFLINE_USER_DATA // tests: simulates a second Windows account
    ? path.resolve(process.env.NOTA_OFFLINE_USER_DATA)
    : path.join(app.getPath('appData'), EDITION.productName)
);

// Development-only test hook: answers file dialogs and confirmations from a JSON file, because
// native dialogs cannot be automated. The installed app never reads it.
const TEST_DIALOGS_FILE = app.isPackaged ? null : process.env.NOTA_OFFLINE_TEST_DIALOGS || null;
// Development-only: shorter automatic backup timing for tests, and a folder that counts as
// another drive, as JSON ({ "firstCheckDelayMs": 3000, "checkIntervalMs": 5000, "otherDrive": "..." }).
const TEST_AUTO_BACKUP = app.isPackaged ? null : JSON.parse(process.env.NOTA_OFFLINE_TEST_AUTO_BACKUP || 'null');

const startHidden = process.argv.includes('--hidden'); // started by Windows at login
const quitRequested = process.argv.includes('--quit'); // a script asks this account's copy to stop
// The installer, before it replaces or removes the app: every copy it can reach stops, including
// the server in another Windows account, and the call returns once the database has stopped.
const quitAllRequested = process.argv.includes('--quit-all');

const state = {
  mode: 'starting', // setup | main | attached | client
  paths: null,
  resources: null,
  logger: null,
  log: null,
  config: null,
  secret: null,
  apiOrigin: null,
  serverInfo: null, // client: the main PC's /api/lan/info answer
  supervisor: null,
  backend: null, // main PC: the BackendManager (Stage 15: its env changes after a restore)
  serverLock: null,
  responder: null,
  monitor: null,
  setup: null,
  setupStartStep: null,
  backups: null,
  backupBusy: false,
  autoBackup: null,
  mainPcWatcher: null, // Stage 15: another main PC on the LAN
  otherMainPcs: [],
  firewallMissing: null, // main PC: firewall rule names the installer should have added
  window: null,
  tray: null,
  status: { state: 'starting', label: statusLabel({ state: 'starting' }), appVersion: EDITION.version },
  connection: { connected: true },
  uiLoaded: false,
  quitting: false,
  quitPromise: null,
  powerBlocker: null,
  hideNoticeShown: false,
};

const log = {
  info: (message) => state.log && state.log.info(message),
  warn: (message) => state.log && state.log.warn(message),
  error: (message) => (state.log ? state.log.error(message) : console.error(message)),
};

const loadDriver = () => require(path.join(state.resources.backendDir, 'node_modules', 'mongodb'));
const loadBson = () => require(path.join(state.resources.backendDir, 'node_modules', 'bson'));

// ---------------------------------------------------------------- status, connection and UI

function setStatus(status) {
  state.status = { ...status, label: statusLabel(status), appVersion: EDITION.version };
  log.info(`status: ${status.state}${status.reason ? ` (${status.reason})` : ''}${status.code ? ` ${status.code}` : ''}`);
  send('nota:status', state.status);
  updateTray();

  if (status.state === 'running') {
    if (state.powerBlocker === null) state.powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
    startResponder();
    startAutoBackup();
    startMainPcWatcher();
    if (!state.uiLoaded) loadUi();
  } else if (status.state === 'failed' || status.state === 'stopped') {
    stopPowerBlocker();
  }

  // On the main PC the overlay covers the app while the server restarts or makes the daily
  // backup. Not for a backup or restore started on the backup page: it shows its own progress.
  if (state.mode === 'main' && state.uiLoaded) {
    if (status.state === 'restarting') setConnection({ connected: false, reason: 'server-restarting' });
    if (status.state === 'maintenance' && status.reason === 'auto-backup') {
      setConnection({ connected: false, reason: 'server-maintenance' });
    }
    if (status.state === 'running') setConnection({ connected: true });
  }

  // A lost connection while the app is open shows Angular's overlay instead (status.overlay),
  // so a half-finished invoice is not thrown away.
  if (['failed', 'not-configured', 'unreachable', 'unauthorized', 'not-nota'].includes(status.state) && !status.overlay) {
    if (state.uiLoaded) showStatusPage();
    showWindow();
  }
}

function setConnection(connection) {
  state.connection = { ...connection, role: state.config ? state.config.role : null };
  send('nota:connection', state.connection);
}

function send(channel, value) {
  const win = state.window;
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function stopPowerBlocker() {
  if (state.powerBlocker !== null) {
    powerSaveBlocker.stop(state.powerBlocker);
    state.powerBlocker = null;
  }
}

function loadUi() {
  state.uiLoaded = true;
  state.connection = { connected: true, role: state.config ? state.config.role : null };
  state.window.loadFile(path.join(state.resources.uiDir, 'index.html')).catch((error) => {
    log.error(`could not load the app: ${error.message}`);
  });
}

function loadPage(name, hash) {
  state.uiLoaded = false;
  state.window.loadFile(path.join(__dirname, 'pages', name), hash ? { hash } : undefined).catch((error) => {
    log.error(`could not load ${name}: ${error.message}`);
  });
}

const showStatusPage = () => loadPage('status.html');

function showWindow() {
  const win = state.window;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// The window only hides while this copy runs the server, so client PCs stay connected.
function serverIsActive() {
  return Boolean(state.supervisor) && ['starting', 'running', 'restarting', 'maintenance'].includes(state.status.state);
}

function createWindow() {
  const iconPath = path.join(state.resources.uiDir, 'favicon.ico');
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: EDITION.productName,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  state.window = win;

  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });

  win.on('close', (event) => {
    if (state.quitting) return;
    event.preventDefault();
    if (serverIsActive()) {
      win.hide();
      showHiddenNotice();
    } else {
      gracefulQuit('window closed');
    }
  });

  // Windows is shutting down, restarting, logging off, or an installer asks the app to close.
  win.on('query-session-end', (event) => {
    if (serverIsActive()) event.preventDefault(); // give mongod time for a clean shutdown
    gracefulQuit(`Windows session end (${(event.reasons || []).join(', ')})`);
  });
  win.on('session-end', () => gracefulQuit('Windows session ended'));

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error(`page process gone: ${details.reason}`);
    if (state.quitting) return;
    if (state.uiLoaded) loadUi();
    else if (state.mode === 'setup') showSetup(state.setupStartStep);
    else showStatusPage();
  });

  showStatusPage();
}

function showHiddenNotice() {
  if (state.hideNoticeShown || !state.tray) return;
  state.hideNoticeShown = true;
  state.tray.displayBalloon({
    iconType: 'info',
    title: EDITION.productName,
    content:
      'البرنامج ما زال يعمل في الخلفية حتى تبقى الأجهزة الفرعية متصلة. لإيقافه استخدم أيقونة البرنامج بجوار الساعة.',
  });
}

// ---------------------------------------------------------------- tray

function createTray() {
  const icon = nativeImage.createFromPath(path.join(state.resources.uiDir, 'favicon.ico'));
  state.tray = new Tray(icon);
  state.tray.on('click', showWindow);
  state.tray.on('double-click', showWindow);
  updateTray();
}

function updateTray() {
  const tray = state.tray;
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(`${EDITION.productName} ${EDITION.version}\n${state.status.label}`);

  const roleItems = [];
  if (state.mode === 'main') {
    roleItems.push(
      { label: 'النسخ الاحتياطي والاستعادة', click: openBackupPage },
      { label: 'بيانات الاتصال للأجهزة الفرعية', click: showConnectionDetails }
    );
  }
  if (state.mode === 'client') roleItems.push({ label: 'تغيير عنوان الجهاز الرئيسي', click: () => changeAddress() });

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: state.status.label, enabled: false },
      { label: `الإصدار ${EDITION.version}`, enabled: false },
      { type: 'separator' },
      { label: 'فتح البرنامج', click: showWindow },
      ...roleItems,
      { label: 'فتح مجلد السجلات', click: openLogs },
      { type: 'separator' },
      { label: state.supervisor ? 'إيقاف الخادم والخروج' : 'خروج', click: confirmQuit },
    ])
  );
}

// What a client PC needs: the address, the port and the secret.
function showConnectionDetails() {
  const addresses = localIPv4Addresses().map((entry) => `${entry.address}   (${entry.name})`);
  dialog.showMessageBox({
    type: 'info',
    title: EDITION.productName,
    message: 'بيانات الاتصال للأجهزة الفرعية',
    detail: [
      `اسم الجهاز: ${state.config.shopName || os.hostname()}`,
      '',
      'عنوان الجهاز الرئيسي:',
      ...(addresses.length ? addresses : ['لا يوجد اتصال بشبكة']),
      '',
      `المنفذ: ${state.config.port}`,
      `كلمة سر الشبكة: ${state.secret}`,
      '',
      'تجد الأجهزة الفرعية هذا الجهاز تلقائياً في أغلب الشبكات؛ استخدم العنوان يدوياً عند الحاجة.',
      ...(state.firewallMissing && state.firewallMissing.length
        ? ['', 'تنبيه: إعدادات جدار حماية Windows الخاصة بالبرنامج غير موجودة، وقد لا تتمكن الأجهزة الفرعية من الاتصال. أعد تثبيت البرنامج لإضافتها.']
        : []),
    ].join('\n'),
    buttons: ['إغلاق'],
  });
}

async function confirmQuit() {
  if (serverIsActive()) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: EDITION.productName,
      message: 'سيتم إيقاف الخادم، ولن تتمكن الأجهزة الفرعية من الاتصال حتى يتم تشغيله مرة أخرى. هل تريد المتابعة؟',
      buttons: ['إيقاف الخادم والخروج', 'إلغاء'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  gracefulQuit('user chose exit');
}

function openLogs() {
  if (state.paths) shell.openPath(state.paths.logs);
}

function openBackupPage() {
  showWindow();
  if (state.uiLoaded) send('nota:navigate', '/backup');
}

// ---------------------------------------------------------------- dialogs

function testAnswers() {
  return TEST_DIALOGS_FILE ? JSON.parse(fs.readFileSync(TEST_DIALOGS_FILE, 'utf8')) : null;
}

const BACKUP_FILTERS = [
  { name: 'MongoDB archive', extensions: ['gz', 'archive', 'agz'] },
  { name: 'كل الملفات', extensions: ['*'] },
];

async function chooseOpenPath(title) {
  const answers = testAnswers();
  if (answers) return answers.open || null;
  const result = await dialog.showOpenDialog(state.window, { title, properties: ['openFile'], filters: BACKUP_FILTERS });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
}

async function chooseSavePath(title, defaultPath) {
  const answers = testAnswers();
  if (answers) return answers.save || null;
  const result = await dialog.showSaveDialog(state.window, { title, defaultPath, filters: BACKUP_FILTERS });
  return result.canceled || !result.filePath ? null : result.filePath;
}

async function chooseFolder(title) {
  const answers = testAnswers();
  if (answers) return answers.folder || null;
  const result = await dialog.showOpenDialog(state.window, { title, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
}

async function confirmRestore(archive) {
  const answers = testAnswers();
  if (answers) return answers.confirm !== false;
  const { response } = await dialog.showMessageBox(state.window, {
    type: 'warning',
    title: EDITION.productName,
    message: 'استعادة نسخة احتياطية',
    detail: [
      `الملف: ${archive.name} (${archive.sizeMb} ميجابايت)`,
      `يحتوي على ${archive.collections} مجموعة من قاعدة البيانات ${archive.sourceDb}.`,
      '',
      'ستحل محتويات هذا الملف محل كل البيانات الحالية.',
      'سيحفظ البرنامج نسخة من البيانات الحالية تلقائياً قبل البدء، ويتوقف اتصال الأجهزة الفرعية حتى تنتهي الاستعادة.',
    ].join('\n'),
    buttons: ['استعادة', 'إلغاء'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

// ---------------------------------------------------------------- IPC

function fromOurPages(event) {
  const url = event.senderFrame ? event.senderFrame.url : '';
  return url.startsWith('file:');
}

function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromOurPages(event)) throw new Error('not allowed');
    return handler(...args);
  });
}

// Setup calls return { ok, value } or { ok: false, error } so the page shows the Arabic message.
function handleSetup(channel, handler) {
  handle(channel, async (...args) => {
    if (state.mode !== 'setup') return { ok: false, error: { message: 'الإعداد غير متاح الآن.' } };
    try {
      return { ok: true, value: await handler(...args) };
    } catch (error) {
      if (!(error instanceof SetupError)) log.error(`setup: ${error.stack || error.message}`);
      return {
        ok: false,
        error: {
          message: error instanceof SetupError || error.code ? error.message : `حدث خطأ غير متوقع: ${error.message}`,
          field: error.field,
        },
      };
    }
  });
}

function backupService() {
  if (!state.backups) {
    state.backups = new BackupService({
      mongodbBin: state.resources.mongodbBin,
      port: MONGOD_PORT,
      backupsDir: state.paths.backups,
      mongodb: loadDriver(),
      bson: loadBson(),
      log: state.logger('backup'),
    });
  }
  return state.backups;
}

function busyError() {
  const error = new Error('توجد عملية نسخ احتياطي أو استعادة قيد التنفيذ. انتظر حتى تنتهي.');
  error.code = 'BACKUP_BUSY';
  return error;
}

// One backup or restore at a time, whoever started it (the backup page or the daily backup).
async function exclusive(task) {
  if (state.backupBusy) throw busyError();
  state.backupBusy = true;
  try {
    return await task();
  } finally {
    state.backupBusy = false;
  }
}

// The backend is paused while mongodump runs, so no invoice is half-saved in the backup.
// Stage 15: a manual backup (caller = the signed-in user) is audited through the inbox file,
// written before the backend starts again so it reads the entry at startup.
function consistentBackup(file, { reason, onProgress, caller }) {
  return exclusive(() =>
    state.supervisor.runMaintenance(async () => {
      const result = await backupService().createBackup(file, onProgress);
      if (caller) auditBackup('backup.created', caller, file);
      return result;
    }, { reason })
  );
}

const auditInboxPath = () => path.join(state.paths.run, AUDIT_INBOX_NAME);

function auditBackup(action, caller, file, error) {
  try {
    appendAuditEntry(auditInboxPath(), { action, user: caller && caller.user, backupFile: file, code: error && error.code, error: error && error.message });
  } catch (writeError) {
    log.error(`audit inbox: ${writeError.message}`);
  }
}

// Stage 15: the restore replaced the users, so every session issued before now ends (on every PC):
// the backend refuses older tokens (NOTA_SESSIONS_VALID_AFTER) from its next start on. Whole
// seconds, because token times (iat) are whole seconds; the backend was stopped for the whole restore,
// so no token was issued during it.
function endSessionsBeforeNow() {
  const validAfter = Math.floor(Date.now() / 1000) * 1000;
  state.config = writeConfig(state.paths.config, { ...state.config, sessionsValidAfter: validAfter });
  if (state.backend) state.backend.updateEnv({ NOTA_SESSIONS_VALID_AFTER: String(validAfter) });
  log.info('restore: sessions issued before now are ended');
}

// Restore with the backend paused: inside the task, before the backend starts again, the audit
// entry is written and (on success) older sessions are ended.
function restoreArchive(archive, { caller, onProgress }) {
  return exclusive(() => {
    log.info(`restoring ${archive.path}`);
    return state.supervisor.runMaintenance(async () => {
      try {
        const result = await backupService().restore(archive, { safety: true, onProgress });
        auditBackup('backup.restored', caller, archive.path);
        endSessionsBeforeNow();
        return result;
      } catch (error) {
        auditBackup('backup.restore_failed', caller, archive.path, error);
        // Rollback failed: the data may be the new backup's; end the sessions to be safe.
        if (error.code === 'RESTORE_ROLLBACK_FAILED') endSessionsBeforeNow();
        throw error;
      }
    }, {
      reason: 'restore',
      recoverRestart: async (startupError, result) => {
        if (!result?.safetyPath) throw startupError;
        log.error(`restore migration/startup failed, restoring safety backup: ${startupError.message}`);
        onProgress({ phase: 'rolling-back' });
        auditBackup('backup.restore_failed', caller, archive.path, startupError);
        try {
          await backupService().replaceWith(await backupService().inspect(result.safetyPath));
          endSessionsBeforeNow();
        } catch (rollbackError) {
          throw new ServiceError(
            'RESTORE_ROLLBACK_FAILED',
            `فشل تحديث النسخة المسترجعة وتعذر إرجاع البيانات السابقة تلقائياً. نسخة الأمان محفوظة في: ${result.safetyPath}`,
            `${startupError.detail || startupError.message}\n${rollbackError.detail || rollbackError.message}`
          );
        }
        return new ServiceError(
          'RESTORE_MIGRATION_FAILED_ROLLED_BACK',
          `النسخة المسترجعة محتاجة تحديث فشل. رجّعنا البيانات زي ما كانت قبل الاسترجاع\n${startupError.message}`,
          startupError.detail || startupError.message
        );
      },
    });
  });
}

// Daily backup into backups\auto, started once the server first runs.
function startAutoBackup() {
  if (state.mode !== 'main' || state.autoBackup) return;
  const { otherDrive, ...testTiming } = TEST_AUTO_BACKUP || {};
  const inside = (file, folder) => {
    const relative = path.relative(folder, file);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  state.autoBackup = new AutoBackup({
    dir: state.paths.autoBackups,
    statePath: state.paths.backupState,
    dataDir: state.paths.home,
    sameDrive: otherDrive ? async (a, b) => !inside(a, otherDrive) && onSameDrive(a, b) : onSameDrive,
    runBackup: (file) => consistentBackup(file, { reason: 'auto-backup' }),
    getCopyFolder: () => state.config.backupCopyFolder,
    log: state.logger('auto-backup'),
    ...testTiming,
  });
  state.autoBackup.on('change', () => sendBackupStatus());
  state.autoBackup.start();
}

function sendBackupStatus() {
  if (!state.autoBackup) return;
  state.autoBackup
    .summary()
    .then((summary) => send('backup:status', summary))
    .catch((error) => log.error(`backup status: ${error.message}`));
}

function setBackupCopyFolder(folder) {
  state.config = writeConfig(state.paths.config, { ...state.config, backupCopyFolder: folder });
  log.info(folder ? `extra backup folder: ${folder}` : 'extra backup folder cleared');
}

// Stage 15: every backup handler checks the caller in this process (lib/backup-handlers.js).
function backendClient() {
  return createBackendClient({ apiOrigin: state.apiOrigin, secret: state.secret });
}

function copyFolderInvalid(folder) {
  const inside = path.relative(state.paths.home, folder);
  return !inside || (!inside.startsWith('..') && !path.isAbsolute(inside));
}

function registerBackupIpc() {
  const handlers = createBackupHandlers({
    isServerCopy: () => state.mode === 'main' && Boolean(state.supervisor),
    serverRunning: () => state.status.state === 'running',
    isBusy: () => state.backupBusy,
    busyError,
    backend: backendClient,
    chooseSavePath: (defaultPath) => chooseSavePath('حفظ النسخة الاحتياطية', defaultPath),
    chooseOpenPath: () => chooseOpenPath('اختيار ملف النسخة الاحتياطية'),
    chooseFolder: () => chooseFolder('اختيار مجلد إضافي لنسخ النسخة الاحتياطية اليومية (مثل فلاشة أو قرص آخر)'),
    confirmRestore,
    defaultBackupPath: () => path.join(app.getPath('documents'), backupFileName()),
    createBackup: (file, { caller, onProgress }) => consistentBackup(file, { reason: 'backup', onProgress, caller }),
    recordManual: (result) => (state.autoBackup ? state.autoBackup.recordManual(result) : Promise.resolve(true)),
    inspect: (file) => backupService().inspect(file),
    restoreArchive,
    copyFolderInvalid,
    setCopyFolder: setBackupCopyFolder,
    copyNow: () => (state.autoBackup ? state.autoBackup.copyNow() : Promise.resolve()),
    summary: () => (state.autoBackup ? state.autoBackup.summary() : null),
    showItemInFolder: (file) => shell.showItemInFolder(file),
    openBackupsFolder: () => shell.openPath(state.paths.backups),
    onProgress: (value) => send('backup:progress', value),
    // Every window of this PC goes to the sign-in screen with the restore message.
    onRestored: () => setImmediate(() => send('nota:session-reset', { reason: 'restored' })),
    log: state.logger('backup'),
  });
  for (const [channel, handler] of Object.entries(handlers)) handle(channel, handler);
}

// Stage 19: the LAN key plus this PC's identity (config.instanceId, hostname) on every backend request.
function deviceHeaderOptions() {
  return {
    origin: state.apiOrigin,
    secret: state.secret,
    deviceId: state.config ? state.config.instanceId : null,
    deviceName: os.hostname(),
  };
}

// Stage 23: printing and PDF export (lib/print-service.js, lib/print-handlers.js). Per-PC settings in the Nota home folder.
function registerPrintIpc() {
  const service = createPrintService({
    BrowserWindow,
    dialog,
    getMainWindow: () => state.window,
    settingsPath: path.join(state.paths.home, 'print-settings.json'),
    log: state.logger('print'),
  });
  const handlers = createPrintHandlers({ service, backend: backendClient, log: state.logger('print') });
  for (const [channel, handler] of Object.entries(handlers)) handle(channel, handler);
}

function registerIpc() {
  registerBackupIpc();
  registerPrintIpc();
  handle('nota:runtime-config', () => {
    if (!state.apiOrigin || !state.config) throw new Error('the app is not configured');
    return {
      apiBaseUrl: `${state.apiOrigin}/api/`,
      role: state.config.role,
      appVersion: EDITION.version,
      deviceId: state.config.instanceId,
      deviceName: os.hostname(),
      serverVersion:
        state.config.role === 'client' ? (state.serverInfo && state.serverInfo.appVersion) || null : EDITION.version,
    };
  });
  handle('nota:status', () => state.status);
  handle('nota:connection', () => state.connection);
  handle('nota:retry', () => retry());
  handle('nota:retry-connection', () => (state.monitor ? state.monitor.check().then(() => state.connection) : state.connection));
  handle('nota:change-address', () => changeAddress());
  handle('nota:open-logs', () => openLogs());
  handle('nota:quit', () => gracefulQuit('user pressed exit'));
  // Stage 15: other main PCs answering on the LAN (main PC only; read-only).
  handle('nota:other-main', () => (state.mode === 'main' ? state.otherMainPcs : []));

  handleSetup('setup:info', () => ({
    ...state.setup.info(),
    startStep: state.setupStartStep,
    prefill:
      state.config && state.config.role === 'client' ? { host: state.config.mainHost, port: state.config.port } : null,
  }));
  handleSetup('setup:generate-secret', () => state.setup.generateSecret());
  handleSetup('setup:check-port', (port) => state.setup.checkPort(port));
  handleSetup('setup:discover', () => state.setup.discover());
  handleSetup('setup:other-main', () => state.setup.findOtherMainPcs(state.config ? state.config.instanceId : null));
  handleSetup('setup:pick-backup', async () => {
    const file = await chooseOpenPath('اختيار ملف النسخة الاحتياطية');
    return file ? state.setup.inspectBackup(file) : null;
  });
  handleSetup('setup:complete-main', async (input) => {
    const { config, secret } = await state.setup.completeMain(input || {}, (progress) => send('setup:progress', progress));
    setImmediate(() => beginRole(config, secret));
    return true;
  });
  handleSetup('setup:complete-client', async (input) => {
    const { config, secret, info } = await state.setup.completeClient(input || {}, state.config);
    setImmediate(() => beginRole(config, secret, info));
    return true;
  });
}

function retry() {
  if (state.mode === 'client') {
    startClientRole();
  } else if (state.status.state === 'failed') {
    if (state.supervisor) state.supervisor.start();
    else if (state.config && state.secret) startMainRole();
  }
}

// ---------------------------------------------------------------- setup

function showSetup(startStep = null) {
  state.mode = 'setup';
  state.setupStartStep = startStep;
  if (!state.setup) {
    state.setup = new SetupController({
      paths: state.paths,
      resources: state.resources,
      log: state.logger('setup'),
      appVersion: EDITION.version,
      getServerLock: async () => {
        if (!state.serverLock) state.serverLock = await holdServerLock();
        return state.serverLock;
      },
      loadDriver,
      loadBson,
    });
  }
  setStatus({ state: 'setup' });
  loadPage('setup.html');
  showWindow();
}

// Client PC: "change main PC address" from the overlay, the status page or the tray.
function changeAddress() {
  if (!state.config || state.config.role !== 'client') return;
  if (state.monitor) state.monitor.stop();
  showSetup('client');
}

// ---------------------------------------------------------------- roles

function applyLoginItem(config) {
  if (!app.isPackaged) return; // a development run must not register itself at login
  // A fixed name, so the uninstaller can remove the entry (installer-offline/installer.nsh).
  app.setLoginItemSettings({
    openAtLogin: config.startWithWindows,
    path: process.execPath,
    args: ['--hidden'],
    name: EDITION.productName,
  });
}

// The machine-wide server lock. `Nota.exe --quit-all` (the installer) can ask the
// copy holding it to stop, from any Windows account.
const holdServerLock = () =>
  holdPortLock(SERVER_LOCK_PORT, { onQuit: () => gracefulQuit('asked to quit through the server lock (installer)') });

// The installer adds the firewall rules; a missing rule is shown in the connection details.
function checkFirewall() {
  if (!app.isPackaged) return; // development runs are not installed
  missingFirewallRules().then((missing) => {
    state.firewallMissing = missing;
    if (missing === null) log.warn('could not check the Windows Firewall rules');
    else if (missing.length) log.warn(`Windows Firewall rules missing: ${missing.join(', ')}; client PCs may not connect`);
  });
}

async function beginRole(config, secret, serverInfo) {
  state.config = config;
  try {
    state.secret = secret || unprotectSecret(config.lanSecretProtected);
  } catch (error) {
    log.error(`secret: ${error.message}`);
    setStatus({
      state: 'failed',
      code: 'SECRET_UNREADABLE',
      message: 'تعذر قراءة كلمة سر الشبكة على هذا الجهاز. أعد إعداد البرنامج.',
      detail: error.message,
    });
    return;
  }
  applyLoginItem(config);

  if (config.role === 'main') {
    state.mode = 'main';
    state.apiOrigin = `http://127.0.0.1:${config.port}`;
    installSecretHeader(session.defaultSession, deviceHeaderOptions());
    await startMainRole();
  } else {
    state.mode = 'client';
    await startClientRole(serverInfo);
  }
}

async function backendAnswers() {
  try {
    const response = await fetch(`${state.apiOrigin}/api/lan/info`, {
      headers: { [LAN_KEY_HEADER]: state.secret },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Another Windows account on this PC already runs the server: use it instead of starting a
// second database on the same data folder.
async function attachToRunningServer() {
  log.info('the server is already running under another Windows account; attaching to it');
  state.mode = 'attached';
  setStatus({ state: 'attached' });
  if (await waitFor(backendAnswers, { timeoutMs: ATTACH_TIMEOUT_MS, intervalMs: 1000 })) {
    loadUi();
    return;
  }
  setStatus({
    state: 'failed',
    code: 'SERVER_OTHER_ACCOUNT',
    message: 'الخادم يعمل من حساب Windows آخر على هذا الجهاز لكنه لا يستجيب. سجّل الدخول إلى ذلك الحساب أو أعد تشغيل الجهاز.',
  });
}

// Stage 13/14: the backend's session-token secret (NOTA_JWT_SECRET), main PC only. Stage 14 runs
// the backend with NOTA_AUTH=1, so a secret that cannot be read or created is fatal, like
// SECRET_UNREADABLE: the error screen is shown and the backend is not started.
function readJwtSecret() {
  try {
    const result = loadJwtSecret({
      config: state.config,
      configPath: state.paths.config,
      protectSecret,
      unprotectSecret,
      writeConfig,
      log,
    });
    state.config = result.config;
    return result.secret;
  } catch (error) {
    log.error(`session-token secret: ${error.message}`);
    setStatus({
      state: 'failed',
      code: 'JWT_SECRET_UNREADABLE',
      message: 'تعذر قراءة مفتاح تسجيل الدخول على هذا الجهاز، فلم يتم تشغيل الخادم. أعد إعداد البرنامج كجهاز رئيسي، أو اتصل بالدعم الفني.',
      detail: error.message,
    });
    return null;
  }
}

async function startMainRole() {
  if (!state.serverLock) state.serverLock = await holdServerLock();
  if (!state.serverLock) {
    await attachToRunningServer();
    return;
  }
  const jwtSecret = readJwtSecret();
  if (!jwtSecret) return; // the error screen is showing; never start the backend without it
  const { paths, resources, config } = state;
  checkFirewall();

  const mongod = new MongodManager({
    mongodPath: path.join(resources.mongodbBin, 'mongod.exe'),
    dbPath: paths.dbPath,
    logFile: path.join(paths.logs, 'mongod.log'),
    pidFile: path.join(paths.run, 'mongod.pid'),
    port: MONGOD_PORT,
    mongodb: loadDriver(),
    log: state.logger('mongod'),
  });

  const backendLog = createLogger(path.join(paths.logs, 'backend.log'));
  const backend = new BackendManager({
    utilityProcess,
    serverPath: path.join(resources.backendDir, 'src', 'server.js'),
    cwd: paths.run, // never the backend folder: a developer's .env there must not load
    env: buildBackendEnv({
      port: config.port,
      mongoUri: mongod.uri,
      secret: state.secret,
      jwtSecret,
      appVersion: EDITION.version,
      instanceId: config.instanceId,
      sessionsValidAfter: config.sessionsValidAfter,
      auditInbox: path.join(paths.run, AUDIT_INBOX_NAME),
    }),
    port: config.port,
    log: state.logger('backend'),
    output: backendLog.raw('[backend]'),
  });

  state.backend = backend;
  state.supervisor = new MainPcSupervisor({ mongod, backend, log: state.logger('supervisor') });
  state.supervisor.on('status', setStatus);
  updateTray();
  await state.supervisor.start();
}

// Lets client PCs find this main PC. Started once the server runs.
function startResponder() {
  if (state.mode !== 'main' || state.responder) return;
  state.responder = new DiscoveryResponder({
    log: state.logger('discovery'),
    getInfo: () => ({
      instanceId: state.config.instanceId,
      shopName: state.config.shopName || os.hostname(),
      port: state.config.port,
      appVersion: EDITION.version,
    }),
  });
  state.responder.start();
}

// Stage 15: warns (never stops anything) when another main PC answers on the LAN.
function startMainPcWatcher() {
  if (state.mode !== 'main' || state.mainPcWatcher) return;
  state.mainPcWatcher = new MainPcWatcher({
    discover: () => discoverServers(),
    ownInstanceId: state.config.instanceId,
    log: state.logger('discovery'),
  });
  state.mainPcWatcher.on('change', (others) => {
    state.otherMainPcs = others;
    send('nota:other-main', others);
  });
  state.mainPcWatcher.start();
}

function setClientAddress(host, port) {
  state.config = writeConfig(state.paths.config, { ...state.config, mainHost: host, port });
  state.apiOrigin = `http://${host}:${port}`;
  installSecretHeader(session.defaultSession, deviceHeaderOptions());
}

const clientTarget = () => ({
  host: state.config.mainHost,
  port: state.config.port,
  secret: state.secret,
  instanceId: state.config.mainInstanceId,
});

const CLIENT_ERRORS = {
  unreachable: () =>
    `تعذر الاتصال بالجهاز الرئيسي (${state.config.mainHost}:${state.config.port}). تأكد أن الجهاز الرئيسي يعمل وأن البرنامج مفتوح عليه، وأن الجهازين على نفس الشبكة.`,
  unauthorized: () => 'كلمة سر الشبكة على هذا الجهاز لا تطابق الجهاز الرئيسي. أدخل كلمة السر الصحيحة.',
  'not-nota': () => `العنوان ${state.config.mainHost}:${state.config.port} لا يخص جهاز ${EDITION.nameAr} رئيسي.`,
};

async function startClientRole(knownInfo) {
  if (state.monitor) state.monitor.stop();
  state.apiOrigin = `http://${state.config.mainHost}:${state.config.port}`;
  installSecretHeader(session.defaultSession, deviceHeaderOptions());
  setStatus({ state: 'connecting' });

  let result = knownInfo ? { status: 'ok', info: knownInfo } : await probeServer(clientTarget());

  // The main PC may have a new IP address: look for the same main PC on the LAN.
  if (result.status === 'unreachable' && state.config.mainInstanceId) {
    const servers = await discoverServers();
    const same = servers.find((server) => server.instanceId === state.config.mainInstanceId);
    if (same) {
      log.info(`main PC found at a new address ${same.address}:${same.port}`);
      setClientAddress(same.address, same.port);
      result = await probeServer(clientTarget());
    }
  }

  if (result.status !== 'ok') {
    setStatus({ state: result.status, code: `MAIN_PC_${result.status.toUpperCase().replace(/-/g, '_')}`, message: CLIENT_ERRORS[result.status](), detail: result.detail });
    return;
  }

  state.serverInfo = result.info;
  if (result.info.appVersion !== EDITION.version) {
    log.warn(`version mismatch: this PC ${EDITION.version}, main PC ${result.info.appVersion}`);
  }
  setStatus({ state: 'connected' });
  loadUi();

  state.monitor = new ConnectionMonitor({ getTarget: clientTarget, log: state.logger('connection') });
  state.monitor.on('change', ({ connected, reason }) => {
    setConnection(connected ? { connected: true } : { connected: false, reason, address: `${state.config.mainHost}:${state.config.port}` });
    setStatus({ state: connected ? 'connected' : reason === 'unauthorized' ? 'unauthorized' : 'unreachable', overlay: true });
  });
  state.monitor.on('moved', async ({ host, port }) => {
    setClientAddress(host, port);
    const moved = await probeServer(clientTarget());
    if (moved.status === 'ok') {
      state.serverInfo = moved.info;
      setStatus({ state: 'connected' });
      loadUi(); // Angular reads the API address at startup
    }
  });
  state.monitor.start();
}

// ---------------------------------------------------------------- startup and shutdown

async function start() {
  Menu.setApplicationMenu(null);

  state.paths = layout(resolveHome({ isPackaged: app.isPackaged }));
  ensureLayout(state.paths, { log: console });
  state.logger = createLogger(path.join(state.paths.logs, 'app.log'), { echo: !app.isPackaged });
  state.log = state.logger('main');
  log.info(`${EDITION.productName} ${EDITION.version} starting (${app.isPackaged ? 'installed' : 'development'})`);
  log.info(`home folder: ${state.paths.home}`);

  state.resources = resolveResources({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  registerIpc();
  createWindow();
  createTray();

  let config;
  try {
    config = readConfig(state.paths.config);
  } catch (error) {
    log.error(`config: ${error.message}`);
    setStatus({ state: 'failed', code: 'CONFIG_INVALID', message: 'ملف الإعدادات تالف. احذفه من مجلد البرنامج ثم أعد الإعداد.', detail: error.message });
    return;
  }
  if (!config) {
    showSetup();
    return;
  }
  await beginRole(config);
}

function gracefulQuit(reason) {
  if (state.quitPromise) return state.quitPromise;
  state.quitting = true;
  log.info(`shutting down: ${reason}`);

  const watchdog = setTimeout(() => {
    log.error('shutdown took too long; exiting anyway');
    app.exit(1);
  }, SHUTDOWN_WATCHDOG_MS);

  state.quitPromise = (async () => {
    if (state.monitor) state.monitor.stop();
    if (state.autoBackup) state.autoBackup.stop();
    if (state.mainPcWatcher) state.mainPcWatcher.stop();
    if (state.responder) await state.responder.stop();
    try {
      if (state.supervisor) await state.supervisor.stop();
    } catch (error) {
      log.error(`stopping the server failed: ${error.message}`);
    }
    stopPowerBlocker();
    if (state.serverLock) await new Promise((resolve) => state.serverLock.close(() => resolve()));
    clearTimeout(watchdog);
    log.info('stopped cleanly');
    if (state.tray && !state.tray.isDestroyed()) state.tray.destroy();
    app.exit(0);
  })();
  return state.quitPromise;
}

function fatal(error) {
  log.error(`fatal: ${error && error.stack ? error.stack : error}`);
  dialog.showErrorBox(EDITION.productName, `حدث خطأ غير متوقع:\n${error && error.message ? error.message : error}`);
  app.exit(1);
}

// `Nota.exe --quit-all`, run by the installer before it replaces or removes the
// app: asks the running copies to stop cleanly and returns once the database has stopped, so
// the installer never has to kill mongod.
async function quitAll() {
  // A copy in this Windows account gets the request through the single-instance lock...
  app.requestSingleInstanceLock({ quit: true });
  // ...and the copy that runs the server, in whichever account, through the server lock port.
  await requestQuit(SERVER_LOCK_PORT);
  // The server copy releases the port last, after mongod has stopped.
  return waitFor(() => isPortFree(SERVER_LOCK_PORT), { timeoutMs: QUIT_ALL_TIMEOUT_MS, intervalMs: 500 });
}

if (quitAllRequested) {
  quitAll().then(
    (stopped) => app.exit(stopped ? 0 : 1),
    () => app.exit(1)
  );
} else if (!app.requestSingleInstanceLock({ quit: quitRequested })) {
  // Another copy runs in this Windows session; it receives our arguments and acts on them.
  app.exit(0);
} else if (quitRequested) {
  // Asked to stop a copy that is not running: nothing to do.
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv, _cwd, data) => {
    if ((data && data.quit) || argv.includes('--quit')) gracefulQuit('another launch asked the app to quit');
    else showWindow();
  });
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (!state.quitting) {
      event.preventDefault();
      gracefulQuit('quit requested');
    }
  });
  app.whenReady().then(start).catch(fatal);
}
