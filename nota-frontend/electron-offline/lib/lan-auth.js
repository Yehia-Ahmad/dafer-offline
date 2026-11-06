'use strict';

// Adds the LAN secret header to every request the app's pages send to the backend: API
// calls, <img> product images and file downloads alike. The secret stays in the main
// process and never reaches the Angular code.
//
// Stage 19: it also names this PC (X-Nota-Device-Id = this PC's config.instanceId, and
// X-Nota-Device-Name = its hostname). The backend uses them only to choose a default cash box and
// to list the PCs; they are NOT an authentication factor (permissions and shifts follow the user).

const LAN_KEY_HEADER = 'X-Nota-Lan-Key';
const DEVICE_ID_HEADER = 'X-Nota-Device-Id';
const DEVICE_NAME_HEADER = 'X-Nota-Device-Name';
const DEVICE_NAME_MAX = 64;

// HTTP header values must stay printable ASCII: the hostname is trimmed to 64 characters and
// sent percent-encoded; the backend decodes it.
function deviceNameHeader(name) {
  const trimmed = String(name || '').trim().slice(0, DEVICE_NAME_MAX);
  return trimmed ? encodeURIComponent(trimmed) : '';
}

function installSecretHeader(session, { origin, secret, deviceId, deviceName }) {
  const filter = { urls: [`${origin}/*`] };
  const device = {};
  if (deviceId) {
    device[DEVICE_ID_HEADER] = String(deviceId);
    const encodedName = deviceNameHeader(deviceName);
    if (encodedName) device[DEVICE_NAME_HEADER] = encodedName;
  }
  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [LAN_KEY_HEADER]: secret, ...device } });
  });
}

module.exports = { LAN_KEY_HEADER, DEVICE_ID_HEADER, DEVICE_NAME_HEADER, DEVICE_NAME_MAX, deviceNameHeader, installSecretHeader };
