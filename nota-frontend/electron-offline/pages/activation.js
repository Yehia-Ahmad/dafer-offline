'use strict';

// Stage 24: the activation screen (Arabic / English). Shown instead of the app while this main PC has no valid license.
(() => {
  const desktop = window.notaDesktop;
  const $ = (id) => document.getElementById(id);

  const TEXT = {
    ar: {
      brand: 'نوتة',
      title: 'تفعيل الترخيص',
      lead: 'النسخة دي محتاجة ترخيص للجهاز الرئيسي. ابعت رقم الجهاز ده للمسؤول عن الترخيص وهو يبعتلك الترخيص.',
      machineLabel: 'رقم هذا الجهاز (Machine ID)',
      machineHint: 'ابعت الرقم ده للمورّد عشان يصدر لك الترخيص.',
      copy: 'نسخ',
      copied: 'تم النسخ',
      pasteLabel: 'الصق نص الترخيص هنا',
      activate: 'تفعيل',
      loadFile: 'تحميل ملف nota.lic',
      skipClient: 'ده جهاز فرعي (مش محتاج ترخيص)',
      quit: 'خروج',
      errorCode: 'رمز الخطأ:',
      doneTitle: 'تم تفعيل الترخيص',
      doneShop: 'اسم المحل:',
      continue: 'متابعة',
      empty: 'الصق نص الترخيص الأول.',
      other: 'Language',
      errors: {
        MALFORMED: 'النص ده مش شكل ترخيص نوتة. تأكد إنك نسخته كامل.',
        BAD_SIGNATURE: 'الترخيص ده غير صحيح أو اتعدّل. اطلب ترخيص جديد.',
        WRONG_MACHINE: 'الترخيص ده اتصدر لجهاز تاني. ابعت رقم الجهاز ده واطلب ترخيص ليه.',
        UNKNOWN_TYPE: 'نوع الترخيص ده غير مدعوم في هذه النسخة.',
        UNKNOWN_VERSION: 'صيغة الترخيص دي أحدث من هذه النسخة. حدّث البرنامج.',
        NO_MACHINE_ID: 'تعذر قراءة رقم هذا الجهاز. اتصل بالدعم الفني.',
        UNREADABLE: 'تعذر قراءة الملف.',
        DEFAULT: 'تعذر تفعيل الترخيص.',
      },
    },
    en: {
      brand: 'Nota',
      title: 'Activate the license',
      lead: 'This copy needs a license for the main PC. Send this PC\'s ID to your vendor and they will send you the license.',
      machineLabel: 'This PC\'s ID (Machine ID)',
      machineHint: 'Send this ID to the vendor so they can issue your license.',
      copy: 'Copy',
      copied: 'Copied',
      pasteLabel: 'Paste the license text here',
      activate: 'Activate',
      loadFile: 'Load nota.lic file',
      skipClient: 'This is a client PC (no license needed)',
      quit: 'Exit',
      errorCode: 'Error code:',
      doneTitle: 'License activated',
      doneShop: 'Shop name:',
      continue: 'Continue',
      empty: 'Paste the license text first.',
      other: 'العربية',
      errors: {
        MALFORMED: 'This is not a Nota license. Make sure you copied all of it.',
        BAD_SIGNATURE: 'This license is not valid or was changed. Ask for a new one.',
        WRONG_MACHINE: 'This license was issued for another PC. Send this PC\'s ID and ask for a license for it.',
        UNKNOWN_TYPE: 'This license type is not supported by this version.',
        UNKNOWN_VERSION: 'This license format is newer than this version. Update the app.',
        NO_MACHINE_ID: 'This PC\'s ID could not be read. Contact support.',
        UNREADABLE: 'The file could not be read.',
        DEFAULT: 'The license could not be activated.',
      },
    },
  };

  let lang = 'ar';
  let info = { machineId: '', canSkip: false };
  let lastError = null;

  const t = () => TEXT[lang];

  function renderError() {
    $('error').hidden = !lastError;
    if (!lastError) return;
    $('error-message').textContent = lastError.message || t().errors[lastError.code] || t().errors.DEFAULT;
    $('error-code').textContent = lastError.code || '';
  }

  function apply() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-t]').forEach((el) => {
      const value = t()[el.dataset.t];
      if (typeof value === 'string') el.textContent = value;
    });
    $('lang').textContent = t().other;
    renderError();
  }

  const showError = (code, message) => {
    lastError = { code, message };
    renderError();
  };

  function done(result) {
    $('shop-name').textContent = (lang === 'en' && result.shopNameEn) || result.shopName || '';
    $('step-ask').hidden = true;
    $('step-done').hidden = false;
  }

  async function submit(call) {
    lastError = null;
    renderError();
    const response = await call();
    if (response && response.ok && response.value && response.value.cancelled) return;
    if (!response || !response.ok) return showError((response && response.error && response.error.code) || 'DEFAULT', null);
    return done(response.value);
  }

  $('lang').addEventListener('click', () => {
    lang = lang === 'ar' ? 'en' : 'ar';
    apply();
  });
  $('copy').addEventListener('click', async () => {
    await desktop.activation.copyMachineId();
    $('copy').textContent = t().copied;
    setTimeout(() => { $('copy').textContent = t().copy; }, 1500);
  });
  $('activate').addEventListener('click', () => {
    const text = $('license-text').value.trim();
    if (!text) return showError('EMPTY', t().empty);
    return submit(() => desktop.activation.activate(text));
  });
  $('load-file').addEventListener('click', () => submit(() => desktop.activation.loadFile()));
  $('skip-client').addEventListener('click', () => desktop.activation.skipClient());
  $('continue').addEventListener('click', () => desktop.activation.finish());
  $('quit').addEventListener('click', () => desktop.quit());

  desktop.activation.info().then((response) => {
    if (response && response.ok) info = response.value;
    $('machine-id').textContent = info.machineId || '----';
    $('skip-client').hidden = !info.canSkip;
    apply();
  });
  apply();
})();
