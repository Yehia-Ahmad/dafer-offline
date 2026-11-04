'use strict';

// Adds the LAN secret header to every request the app's pages send to the backend: API
// calls, <img> product images and file downloads alike. The secret stays in the main
// process and never reaches the Angular code.

const LAN_KEY_HEADER = 'X-Nota-Lan-Key';

function installSecretHeader(session, { origin, secret }) {
  const filter = { urls: [`${origin}/*`] };
  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [LAN_KEY_HEADER]: secret } });
  });
}

module.exports = { LAN_KEY_HEADER, installSecretHeader };
