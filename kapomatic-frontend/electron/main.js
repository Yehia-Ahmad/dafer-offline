const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const DIST_ROOT = path.join(__dirname, '..', 'dist');
const LEGACY_DIST_CANDIDATES = [
  path.join(DIST_ROOT, 'okland-warranty-system-v2', 'browser'),
  path.join(DIST_ROOT, 'okland-warranty-system-v2'),
  path.join(DIST_ROOT, 'kapomatic-inventory-system', 'browser'),
  path.join(DIST_ROOT, 'kapomatic-inventory-system'),
];
const ICON_CANDIDATES = [
  path.join('assets', 'img', 'Kapo.jpeg'),
  path.join('assets', 'img', 'Kapo.jpg'),
  path.join('assets', 'img', 'Kapo.png'),
];
let appDistPath = null;

// Allow direct API access from desktop renderer (e.g. http://167.86.71.200/api/).
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

function hasIndexHtml(candidate) {
  return fs.existsSync(path.join(candidate, 'index.html'));
}

function collectDistCandidates() {
  const candidates = [...LEGACY_DIST_CANDIDATES];

  if (!fs.existsSync(DIST_ROOT)) {
    return candidates;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(DIST_ROOT, { withFileTypes: true });
  } catch {
    return candidates;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectDist = path.join(DIST_ROOT, entry.name);
    candidates.push(path.join(projectDist, 'browser'));
    candidates.push(projectDist);
  }

  return [...new Set(candidates)];
}

function resolveDistPath() {
  for (const candidate of collectDistCandidates()) {
    if (hasIndexHtml(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Angular build output not found. Run `npm run build:desktop` before launching Electron.',
  );
}

function resolveAppIconPath(distPath) {
  const candidates = ICON_CANDIDATES.map((relativePath) => path.join(distPath, relativePath));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function createWindow() {
  const distPath = appDistPath || resolveDistPath();
  const indexPath = path.join(distPath, 'index.html');
  const iconPath = resolveAppIconPath(distPath);
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

  await mainWindow.loadFile(indexPath);
}

app
  .whenReady()
  .then(async () => {
    appDistPath = resolveDistPath();
    await createWindow();
  })
  .catch((error) => {
    console.error(error);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
