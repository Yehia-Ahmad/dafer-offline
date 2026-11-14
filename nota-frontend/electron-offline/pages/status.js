'use strict';

(() => {
  const desktop = window.notaDesktop;
  const $ = (id) => document.getElementById(id);
  const busyStates = new Set(['starting', 'restarting', 'stopping', 'connecting']);
  const errorStates = new Set(['failed', 'not-configured', 'unreachable', 'unauthorized', 'not-nota', 'not-activated', 'damaged']);
  const retryStates = new Set(['failed', 'unreachable', 'unauthorized', 'not-nota', 'not-activated']);
  const addressStates = new Set(['unreachable', 'unauthorized', 'not-nota']);

  function render(status) {
    $('label').textContent = status.label || '';
    $('spinner').hidden = !busyStates.has(status.state);
    $('version').textContent = status.appVersion || '';

    $('error').hidden = !errorStates.has(status.state) || !status.message;
    $('error-message').textContent = status.message || '';
    $('error-code').textContent = status.code || '';
    $('error-detail').hidden = !status.detail;
    $('error-detail').textContent = status.detail || '';
    $('retry').hidden = !retryStates.has(status.state);
    $('change-address').hidden = !addressStates.has(status.state);
  }

  $('retry').addEventListener('click', () => desktop.retry());
  $('change-address').addEventListener('click', () => desktop.changeServerAddress());
  $('logs').addEventListener('click', () => desktop.openLogs());
  $('quit').addEventListener('click', () => desktop.quit());

  desktop.onStatus(render);
  desktop.getStatus().then(render);
})();
