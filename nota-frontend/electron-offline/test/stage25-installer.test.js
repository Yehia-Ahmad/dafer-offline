'use strict';

// Stage 25, step D: the installer. The uninstaller's "delete all my data" decision is compiled with the real makensis (the one electron-builder
// uses) and RUN against a fake ProgramData folder in a temp directory: nothing here touches C:\ProgramData\Nota or the installed Nota.
// The rest are checks on the NSIS sources and the builder config (languages, the data page, the second confirmation, code signing path).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const FRONTEND = path.resolve(__dirname, '..', '..');
const INSTALLER = path.join(FRONTEND, 'installer-offline');
const read = (file) => fs.readFileSync(file, 'utf8');
const builderConfig = JSON.parse(read(path.join(FRONTEND, 'electron-builder.offline.json')));

function findMakensis() {
  const roots = [path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'nsis')];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { entries = []; }
    for (const entry of entries.filter((name) => /^nsis-\d/.test(name))) {
      const candidate = path.join(root, entry, 'Bin', 'makensis.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}
const makensis = process.platform === 'win32' ? findMakensis() : null;
const skip = !makensis && process.env.NOTA_ALLOW_SKIP === '1' ? 'no makensis in the electron-builder cache (NOTA_ALLOW_SKIP=1)' : false;

function runScenario({ updated, silent, checked, confirmed }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-nsis-'));
  try {
    const programData = path.join(work, 'ProgramData');
    const data = path.join(programData, 'Nota');
    fs.mkdirSync(path.join(data, 'data', 'db'), { recursive: true });
    fs.writeFileSync(path.join(data, 'data', 'db', 'collection-1.wt'), 'shop data');
    fs.writeFileSync(path.join(data, 'config.json'), '{}');
    fs.writeFileSync(path.join(programData, 'other-program.txt'), 'must survive');
    const exe = path.join(work, 'test-uninstall.exe');
    const out = path.join(work, 'result.txt');
    const compile = spawnSync(makensis, [
      '/V2', `/DT_UPDATED=${updated}`, `/DT_SILENT=${silent}`, `/DT_CHECKED=${checked}`, `/DT_CONFIRMED=${confirmed}`,
      `/DT_ROOT=${programData}`, `/DT_EXE=${exe}`, `/DT_OUT=${out}`, path.join(INSTALLER, 'test-uninstall-data.nsi'),
    ], { cwd: INSTALLER, encoding: 'utf8', timeout: 120000 });
    assert.equal(compile.status, 0, `makensis failed:\n${compile.stdout}\n${compile.stderr}`);
    const run = spawnSync(exe, ['/S'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(run.status, 0, run.stderr);
    return {
      decision: /decision=(\d)/.exec(read(out))[1],
      dataLeft: fs.existsSync(data),
      otherLeft: fs.existsSync(path.join(programData, 'other-program.txt')),
      programDataLeft: fs.existsSync(programData),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

test('uninstall data choice (compiled with makensis and run): data is deleted ONLY when ticked and confirmed, never on upgrade or silent, and nothing else in ProgramData is touched', { skip, timeout: 600000 }, () => {
  assert.ok(makensis, 'makensis not found: run an electron-builder build once so it is cached');
  const cases = [
    // updated silent checked confirmed -> deletes?
    [{ updated: 0, silent: 0, checked: 1, confirmed: 1 }, true, 'ticked and confirmed'],
    [{ updated: 0, silent: 0, checked: 0, confirmed: 0 }, false, 'default: untouched box'],
    [{ updated: 0, silent: 0, checked: 1, confirmed: 0 }, false, 'ticked but the second question was answered No'],
    [{ updated: 0, silent: 0, checked: 0, confirmed: 1 }, false, 'not ticked'],
    [{ updated: 1, silent: 0, checked: 1, confirmed: 1 }, false, 'an upgrade never deletes'],
    [{ updated: 0, silent: 1, checked: 1, confirmed: 1 }, false, 'a silent uninstall never deletes'],
    [{ updated: 1, silent: 1, checked: 1, confirmed: 1 }, false, 'silent upgrade'],
  ];
  for (const [input, deletes, label] of cases) {
    const result = runScenario(input);
    assert.equal(result.decision, deletes ? '1' : '0', label);
    assert.equal(result.dataLeft, !deletes, `${label}: the data folder ${deletes ? 'is deleted' : 'stays'}`);
    assert.ok(result.otherLeft && result.programDataLeft, `${label}: only <ProgramData>\\Nota may go, never its parent or its neighbours`);
  }
});

test('the installer and uninstaller sources: bilingual, the box is unchecked, the second question defaults to No, deletion only through the one macro', () => {
  const raw = fs.readFileSync(path.join(INSTALLER, 'installer.nsh'));
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 with a BOM so NSIS Unicode reads the Arabic text correctly');
  for (const file of ['notaData.nsh', 'test-uninstall-data.nsi']) assert.deepEqual([...fs.readFileSync(path.join(INSTALLER, file)).subarray(0, 3)], [0xef, 0xbb, 0xbf], `${file} has a BOM`);
  const nsh = read(path.join(INSTALLER, 'installer.nsh'));
  const data = read(path.join(INSTALLER, 'notaData.nsh'));
  assert.match(nsh, /\$\{NSD_SetState\} \$notaDeleteBox \$\{BST_UNCHECKED\}/, 'the box starts unchecked');
  assert.match(nsh, /MB_YESNO\|MB_ICONEXCLAMATION\|MB_DEFBUTTON2 "[^"]+" IDYES nota_confirmed/g, 'the second question defaults to No');
  assert.equal((nsh.match(/MB_DEFBUTTON2/g) || []).length, 2, 'Arabic and English second questions');
  assert.match(nsh, /Abort\r?\n\s*nota_confirmed:/, 'a No keeps the user on the page');
  assert.match(nsh, /UninstPage custom un\.notaDataPage un\.notaDataPageLeave/);
  assert.match(nsh, /!insertmacro notaDeleteDataDecide \$R6 \$R7 \$notaDeleteChecked \$notaDeleteConfirmed \$R8/);
  assert.match(nsh, /\$\{If\} \$\{isUpdated\}\r?\n\s*StrCpy \$R6 "1"/);
  assert.match(nsh, /\$\{If\} \$\{Silent\}\r?\n\s*StrCpy \$R7 "1"/);
  assert.ok(!/RMDir \/r/.test(nsh), 'installer.nsh never deletes a folder itself');
  assert.equal((data.match(/RMDir \/r/g) || []).length, 1, 'one deletion, in notaData.nsh');
  assert.match(data, /RMDir \/r "\$\{programData\}\\Nota"/);
  // both languages are there for every message
  for (const text of ['احذف كل بياناتي أيضاً', 'Also delete all my data', 'تأكيد أخير', 'Last confirmation', 'تعذر تثبيت مكتبة', 'could not be installed', 'تعذر إضافة إعدادات جدار حماية', 'Firewall rules could not be added']) assert.ok(nsh.includes(text), text);
  assert.ok(!/MessageBox [^\r\n]*"[^"]*[\u0600-\u06ff][^"]*" \/SD IDOK/.test(nsh.replace(/!macro notaMessage[\s\S]*?!macroend/, '')), 'no Arabic-only message box is left outside the bilingual macro');
});

test('the installer builds in Arabic and English with a language picker, per machine, and keeps the data on uninstall unless asked', () => {
  const nsis = builderConfig.nsis;
  assert.deepEqual(nsis.installerLanguages, ['ar_SA', 'en_US']);
  assert.equal(nsis.multiLanguageInstaller, true);
  assert.equal(nsis.displayLanguageSelector, true);
  assert.equal(nsis.deleteAppDataOnUninstall, false, 'electron-builder itself never deletes data; only the data page does');
  assert.equal(nsis.perMachine, true);
  assert.match(builderConfig.win.artifactName, /Nota-Setup-\$\{version\}/);
});

test('the quit-all stop before an upgrade or uninstall is still in the installer (a clean mongod stop)', () => {
  const nsh = read(path.join(INSTALLER, 'installer.nsh'));
  assert.match(nsh, /customCheckAppRunning/);
  assert.match(nsh, /--quit-all/);
});
