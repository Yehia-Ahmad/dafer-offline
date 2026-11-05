'use strict';

(() => {
  const setup = window.notaDesktop.setup;
  const $ = (id) => document.getElementById(id);
  const steps = ['step-role', 'step-main-warning', 'step-main', 'step-client'];
  let info = null;
  let backup = null;
  let selectedServer = null;
  let busy = false;

  function showStep(id) {
    for (const step of steps) $(step).hidden = step !== id;
    clearError();
  }

  function clearError() {
    $('form-error').hidden = true;
    for (const input of document.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
  }

  // Field names from the main process -> inputs on this page.
  const FIELD_INPUTS = { secret: ['secret', 'client-secret'], port: ['port', 'client-port'], host: ['host'], backup: ['pick-backup'] };

  function showError(error) {
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
    for (const id of FIELD_INPUTS[error.field] || []) {
      const input = $(id);
      if (!input) continue;
      const details = input.closest('details');
      if (details && !input.closest('[hidden]')) details.open = true; // e.g. the port under advanced settings
      if (input.offsetParent === null) continue; // belongs to the other form
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      break;
    }
  }

  function setBusy(value, progressId) {
    busy = value;
    for (const button of document.querySelectorAll('button')) button.disabled = value;
    for (const input of document.querySelectorAll('input')) input.disabled = value;
    if (progressId) $(progressId).hidden = !value;
  }

  // ------------------------------------------------------------ main PC

  function selectedData() {
    const checked = document.querySelector('input[name="data"]:checked');
    return checked ? checked.value : '';
  }

  function updateDataChoice() {
    $('backup-picker').hidden = selectedData() !== 'restore';
  }

  async function pickBackup() {
    clearError();
    const result = await setup.pickBackup();
    if (!result.ok) {
      backup = null;
      $('backup-summary').textContent = '';
      showError(result.error);
      return;
    }
    if (!result.value) return; // dialog cancelled
    backup = result.value;
    const version = backup.serverVersion ? `، من MongoDB ${backup.serverVersion}` : '';
    $('backup-summary').textContent =
      `${backup.name} (${backup.sizeMb} ميجابايت): ${backup.collections} مجموعة من قاعدة البيانات ${backup.sourceDb}${version}. ` +
      (info.hasExistingData
        ? 'ستحل محل كل البيانات الحالية على هذا الجهاز، وستُحفظ نسخة من البيانات الحالية تلقائياً قبل الاستعادة.'
        : 'ستصبح هذه هي بيانات البرنامج على هذا الجهاز.');
  }

  const PROGRESS_TEXT = {
    'starting-database': () => 'جاري تشغيل قاعدة البيانات...',
    'safety-backup': () => 'جاري حفظ نسخة من البيانات الحالية...',
    restoring: ({ done, total }) => `جاري استعادة البيانات... ${done} من ${total}`,
    'rolling-back': () => 'فشلت الاستعادة، جاري إعادة البيانات السابقة...',
    saving: () => 'جاري حفظ الإعدادات...',
  };

  async function saveMain(event) {
    event.preventDefault();
    if (busy) return;
    clearError();
    const dataChoice = selectedData();
    if (dataChoice === 'restore' && !backup) {
      showError({ message: 'اختر ملف النسخة الاحتياطية أولاً.', field: 'backup' });
      return;
    }
    setBusy(true, 'main-progress');
    $('main-progress-text').textContent = 'جاري التحقق...';
    const result = await setup.completeMain({
      shopName: $('shop-name').value,
      secret: $('secret').value,
      port: $('port').value,
      dataChoice,
      backupPath: backup ? backup.path : null,
      startWithWindows: $('start-with-windows').checked,
    });
    if (!result.ok) {
      setBusy(false, 'main-progress');
      showError(result.error);
    }
    // On success the main process replaces this page.
  }

  // ------------------------------------------------------------ client PC

  function renderServers(servers) {
    const list = $('servers');
    list.replaceChildren();
    $('no-servers').hidden = servers.length > 0;
    for (const server of servers) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      const name = document.createElement('strong');
      name.textContent = server.shopName || 'جهاز رئيسي';
      const address = document.createElement('span');
      address.className = 'address';
      address.textContent = `${server.address}:${server.port}`;
      const version = document.createElement('span');
      version.className = 'hint';
      version.textContent = server.appVersion ? ` الإصدار ${server.appVersion}` : '';
      button.append(name, address, version);
      button.addEventListener('click', () => {
        for (const other of list.querySelectorAll('button')) other.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
        selectedServer = server;
        $('host').value = server.address;
        $('client-port').value = server.port;
        $('client-secret').focus();
      });
      item.append(button);
      list.append(item);
    }
    if (servers.length === 1) list.querySelector('button').click();
  }

  async function search() {
    if (busy) return;
    $('no-servers').hidden = true;
    setBusy(true, 'search-progress');
    const result = await setup.discover();
    setBusy(false, 'search-progress');
    renderServers(result.ok ? result.value : []);
  }

  async function connect(event) {
    event.preventDefault();
    if (busy) return;
    clearError();
    setBusy(true, 'client-progress');
    const host = $('host').value.trim();
    const result = await setup.completeClient({
      host,
      port: $('client-port').value,
      secret: $('client-secret').value,
      shopName: selectedServer && selectedServer.address === host ? selectedServer.shopName : '',
    });
    if (!result.ok) {
      setBusy(false, 'client-progress');
      showError(result.error);
    }
  }

  // ------------------------------------------------------------ one main PC (Stage 15)

  let otherMainPrefill = null;

  // "جهاز رئيسي": look for a main PC already on the LAN first.
  async function chooseMain() {
    if (busy) return;
    showStep('step-main-warning');
    $('other-main-box').hidden = true;
    $('main-anyway-confirm').hidden = true;
    $('other-main-actions').hidden = false;
    setBusy(true, 'role-progress');
    const result = await setup.otherMain();
    setBusy(false, 'role-progress');
    const warning = window.NotaSetupMainCheck.mainPcWarning(result.ok ? result.value : []);
    if (!warning) {
      showStep('step-main');
      return;
    }
    otherMainPrefill = warning.prefill;
    $('other-main-message').textContent = warning.message;
    $('other-main-box').hidden = false;
  }

  function useAsClient() {
    showStep('step-client');
    if (otherMainPrefill) {
      $('host').value = otherMainPrefill.host;
      $('client-port').value = otherMainPrefill.port;
      selectedServer = { address: otherMainPrefill.host, port: otherMainPrefill.port, shopName: otherMainPrefill.shopName };
    }
    $('client-secret').focus();
  }

  // ------------------------------------------------------------ start

  async function init() {
    const result = await setup.info();
    info = result.value;
    $('version').textContent = info.appVersion;
    $('shop-name').value = info.computerName;
    $('secret').value = info.suggestedSecret;
    $('port').value = info.defaultPort;
    $('client-port').value = (info.prefill && info.prefill.port) || info.defaultPort;
    if (info.prefill && info.prefill.host) $('host').value = info.prefill.host;

    // With data already on this PC, starting empty is not offered: it would hide that data.
    $('choice-empty-row').hidden = info.hasExistingData;
    $('choice-existing-row').hidden = !info.hasExistingData;
    document.querySelector(`input[name="data"][value="${info.hasExistingData ? 'existing' : 'empty'}"]`).checked = true;

    $('choose-main').addEventListener('click', chooseMain);
    $('use-as-client').addEventListener('click', useAsClient);
    // A second confirmation before a second main PC.
    $('main-anyway').addEventListener('click', () => {
      $('other-main-actions').hidden = true;
      $('main-anyway-confirm').hidden = false;
    });
    $('main-anyway-cancel').addEventListener('click', () => {
      $('main-anyway-confirm').hidden = true;
      $('other-main-actions').hidden = false;
    });
    $('main-anyway-confirmed').addEventListener('click', () => showStep('step-main'));
    $('choose-client').addEventListener('click', () => {
      showStep('step-client');
      search();
    });
    for (const back of document.querySelectorAll('.back')) back.addEventListener('click', () => showStep('step-role'));
    for (const radio of document.querySelectorAll('input[name="data"]')) radio.addEventListener('change', updateDataChoice);
    $('pick-backup').addEventListener('click', pickBackup);
    $('new-secret').addEventListener('click', async () => {
      $('secret').value = (await setup.generateSecret()).value;
    });
    $('copy-secret').addEventListener('click', () => navigator.clipboard.writeText($('secret').value));
    $('step-main').addEventListener('submit', saveMain);
    $('step-client').addEventListener('submit', connect);
    $('search-again').addEventListener('click', search);

    setup.onProgress((progress) => {
      const text = PROGRESS_TEXT[progress.phase];
      if (text) $('main-progress-text').textContent = text(progress);
    });

    // Opened from "change main PC address": go straight to the client form.
    if (info.startStep === 'client') {
      showStep('step-client');
      search();
    } else {
      showStep('step-role');
    }
  }

  init();
})();
