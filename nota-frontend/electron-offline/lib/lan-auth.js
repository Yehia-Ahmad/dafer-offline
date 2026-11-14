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
const MAIN_TOKEN_HEADER = 'X-Nota-Main-Token';
const DEVICE_NAME_MAX = 64;

// HTTP header values must stay printable ASCII: the hostname is trimmed to 64 characters and
// sent percent-encoded; the backend decodes it.
function deviceNameHeader(name) {
  const trimmed = String(name || '').trim().slice(0, DEVICE_NAME_MAX);
  return trimmed ? encodeURIComponent(trimmed) : '';
}

// mainToken (Stage 24): the main PC's own windows add it so the backend knows the request is the main PC (loopback alone is not enough).
// A client PC has no such token. Install this only on the app's own session, never on the print partition.
function installSecretHeader(session, { origin, secret, deviceId, deviceName, mainToken }) {
  const filter = { urls: [`${origin}/*`] };
  const device = {};
  if (deviceId) {
    device[DEVICE_ID_HEADER] = String(deviceId);
    const encodedName = deviceNameHeader(deviceName);
    if (encodedName) device[DEVICE_NAME_HEADER] = encodedName;
  }
  if (mainToken) device[MAIN_TOKEN_HEADER] = String(mainToken);
  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [LAN_KEY_HEADER]: secret, ...device } });
  });
}

module.exports = { MAIN_TOKEN_HEADER, LAN_KEY_HEADER, DEVICE_ID_HEADER, DEVICE_NAME_HEADER, DEVICE_NAME_MAX, deviceNameHeader, installSecretHeader };
