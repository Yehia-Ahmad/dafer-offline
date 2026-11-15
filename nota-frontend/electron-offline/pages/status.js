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
    // Stage 25: a failure screen can export the diagnostics file without the app running (local, redacted, nothing sent anywhere).
    $('diagnostics').hidden = !errorStates.has(status.state);
  }

  $('retry').addEventListener('click', () => desktop.retry());
  $('change-address').addEventListener('click', () => desktop.changeServerAddress());
  $('logs').addEventListener('click', () => desktop.openLogs());
  $('diagnostics').addEventListener('click', async () => {
    const result = $('diagnostics-result');
    $('diagnostics').disabled = true;
    try {
      const answer = await desktop.diagnostics.exportLocal();
      result.hidden = false;
      if (!answer.ok) result.textContent = answer.error.message;
      else if (answer.value) result.textContent = `تم حفظ الملف: ${answer.value.path}. أرسله للدعم الفني.`;
      else result.hidden = true;
    } catch {
      result.hidden = false;
      result.textContent = 'تعذر إنشاء ملف التشخيص.';
    } finally {
      $('diagnostics').disabled = false;
    }
  });
  $('quit').addEventListener('click', () => desktop.quit());

  desktop.onStatus(render);
  desktop.getStatus().then(render);
})();
