'use strict';

// Stage 24: nothing in a production build opens DevTools or exposes internals.
//   - webPreferences.devTools is false (devToolsAllowed),
//   - no menu (main.js sets it to null) and no shortcut: F12, Ctrl+Shift+I/J/C/R, Ctrl+R / F5 (reload), Ctrl+0 / + / - (zoom reset and zoom),
//   - the context menu is suppressed,
//   - if DevTools ever opens anyway it is closed at once,
//   - remote-debugging / inspect command-line switches stop the app.
// Development runs (not packaged) keep all of it, so developers can work.

// Keys that expose internals or reset the view. `control` is Ctrl (or Cmd on macOS).
function isBlockedShortcut(input) {
  if (!input || input.type !== 'keyDown') return false;
  const key = String(input.key || '').toLowerCase();
  const control = Boolean(input.control || input.meta);
  if (key === 'f12' || key === 'f5') return true;
  if (control && input.shift && ['i', 'j', 'c', 'r'].includes(key)) return true;
  if (control && ['r', 'u', '0', '+', '=', '-', '_'].includes(key)) return true; // reload, view-source, zoom
  if (input.alt && ['arrowleft', 'arrowright'].includes(key)) return true; // history navigation away from the app page
  return false;
}

/** webPreferences.devTools for a window: allowed only in development. */
const devToolsAllowed = (isPackaged) => !isPackaged;

/** Command-line switches that would open a debugging port. */
const DEBUG_SWITCH = /^--(remote-debugging|inspect|debug)/i;
const hasDebugSwitch = (argv) => argv.some((arg) => DEBUG_SWITCH.test(String(arg)));

/** Hardens one webContents (each window, including the print window). No-op when not packaged. */
function hardenContents(contents, { isPackaged }) {
  if (!isPackaged) return false;
  contents.on('before-input-event', (event, input) => {
    if (isBlockedShortcut(input)) event.preventDefault();
  });
  contents.on('context-menu', (event) => event.preventDefault());
  contents.on('devtools-opened', () => contents.closeDevTools());
  contents.setZoomFactor(1);
  contents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  return true;
}

module.exports = { isBlockedShortcut, devToolsAllowed, hasDebugSwitch, hardenContents };
