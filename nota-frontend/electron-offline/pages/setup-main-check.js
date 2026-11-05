'use strict';

// Stage 15: one main PC per shop. Before this PC is set up as the main PC, the setup page looks
// for main PCs already answering on the LAN (setup:other-main). This file holds the wording and
// the choice, without the DOM, so it is unit-tested (test/setup-main-check.test.js).
(function (root) {
  const label = (server) => {
    const name = server.shopName ? `${server.shopName} / ` : '';
    return `${name}${server.address}:${server.port}`;
  };

  /** null when no other main PC answers; otherwise the warning and the client pre-fill. */
  function mainPcWarning(servers) {
    const others = (servers || []).filter((server) => server && server.instanceId && server.address);
    if (!others.length) return null;
    const names = others.map(label).join('، ');
    return {
      message:
        `فيه جهاز رئيسي تاني شغال على الشبكة (${names}). ` +
        'لازم يكون فيه جهاز رئيسي واحد بس في المحل، وإلا البيانات هتتقسم على جهازين.',
      prefill: { host: others[0].address, port: others[0].port, shopName: others[0].shopName || '' },
      count: others.length,
    };
  }

  const api = { mainPcWarning };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NotaSetupMainCheck = api;
})(typeof window === 'undefined' ? globalThis : window);
