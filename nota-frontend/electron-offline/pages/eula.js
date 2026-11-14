'use strict';

// Stage 24: the first-run license agreement (Arabic / English). "I agree" is stored with the date; "I do not agree" exits.
(() => {
  const desktop = window.notaDesktop;
  const $ = (id) => document.getElementById(id);
  const UI = {
    ar: { accept: 'أوافق', decline: 'لا أوافق (خروج)', draft: 'مسودة للمراجعة: الصياغة لم تُعتمد بعد.', other: 'English', brand: 'نوتة' },
    en: { accept: 'I agree', decline: 'I do not agree (exit)', draft: 'DRAFT for review: the wording is not approved yet.', other: 'العربية', brand: 'Nota' },
  };
  let eula = null;
  let lang = 'ar';

  function render() {
    if (!eula) return;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    $('brand').textContent = UI[lang].brand;
    $('title').textContent = eula[lang].title;
    $('contact').textContent = eula.contact[lang];
    $('accept').textContent = UI[lang].accept;
    $('decline').textContent = UI[lang].decline;
    $('lang').textContent = UI[lang].other;
    $('draft').hidden = !eula.draft;
    $('draft').textContent = UI[lang].draft;
    const box = $('text');
    box.replaceChildren(...eula[lang].paragraphs.map((text) => Object.assign(document.createElement('p'), { textContent: text })));
  }

  $('lang').addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; render(); });
  $('accept').addEventListener('click', async () => { $('accept').disabled = true; await desktop.eula.accept(); });
  $('decline').addEventListener('click', () => desktop.eula.decline());

  desktop.eula.text().then((response) => {
    if (response && response.ok) { eula = response.value; render(); }
  });
})();
