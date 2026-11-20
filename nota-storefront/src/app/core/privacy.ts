import { StoreSettings } from './models';

/**
 * Online Stage 7C: the text of /privacy. The owner's own text (website settings) wins; with none, this writes one in Arabic from the
 * shop's name, phone and address. It only states what the site really does: orders, the optional account, the anonymous visit count,
 * the leads, and the Meta / TikTok pixels, which are only mentioned when the shop has set one up (and only "after consent" when the
 * shop requires consent). Plain text: paragraphs are blank-line separated and shown with `white-space: pre-line`.
 */
const shopName = (settings: StoreSettings | null | undefined): string => (settings?.shop?.name || settings?.title || '').trim() || 'المتجر';

export const privacyTitle = (settings: StoreSettings | null | undefined): string => `سياسة الخصوصية — ${shopName(settings)}`;

export const hasCustomPrivacy = (settings: StoreSettings | null | undefined): boolean => Boolean(settings?.privacyPolicy?.trim());

export const privacyText = (settings: StoreSettings | null | undefined): string => {
  const custom = settings?.privacyPolicy?.trim();
  if (custom) return custom;
  const name = shopName(settings);
  const phones = (settings?.shop?.phones ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 2);
  const address = (settings?.shop?.address ?? '').trim();
  const whatsapp = (settings?.contact?.whatsapp ?? '').trim();
  const marketing = settings?.marketing;
  const pixels = [marketing?.metaPixelId ? 'فيسبوك وإنستجرام (Meta)' : '', marketing?.tiktokPixelId ? 'تيك توك' : ''].filter(Boolean);

  const reach = [
    phones.length ? `تليفون: ${phones.join(' / ')}` : '',
    whatsapp ? `واتساب: ${whatsapp}` : '',
    address ? `العنوان: ${address}` : '',
  ].filter(Boolean);
  const channels = [phones.length ? 'التليفون' : '', whatsapp ? 'الواتساب' : ''].filter(Boolean).join(' أو ');

  const sections: string[] = [];
  sections.push(
    `مين إحنا\n${name} متجر إلكتروني. الصفحة دي بتشرح إيه البيانات اللي الموقع بيجمعها وبنستخدمها في إيه.` +
      (reach.length ? `\nللتواصل معانا:\n${reach.join('\n')}` : ''),
  );
  sections.push(
    [
      'البيانات اللي بنجمعها',
      '• الطلبات: اسمك ورقم تليفونك وعنوان التوصيل وملاحظاتك وتفاصيل الطلب. بنستخدمها عشان نجهّز طلبك ونوصّله ونتواصل معاك بخصوصه.',
      '• الحساب (اختياري): لو عملت حساب بنحفظ اسمك ورقم تليفونك وعناوينك وطلباتك السابقة. تقدر تطلب من غير حساب.',
      '• بيانات التواصل (Leads): لو سبت بياناتك في نموذج تسجيل اهتمام من إعلان بتاعنا أو راسلتنا، بنحتفظ باسمك ورقمك عشان نرد عليك.',
      '• الزيارات: بنعدّ الزيارات القادمة من الروابط والإعلانات (الصفحة اللي جيت منها ونوع الجهاز) من غير اسمك ولا رقمك.',
    ].join('\n'),
  );
  sections.push(
    pixels.length
      ? [
          'ملفات تعريف الارتباط وأدوات الإعلانات',
          `الموقع بيستخدم أدوات قياس الإعلانات (${pixels.join(' و')}) عشان نعرف الإعلان جاب طلبات ولا لأ.`,
          marketing?.requireConsent
            ? 'الأدوات دي وملفات تعريف الارتباط بتاعتها مبتشتغلش غير بعد موافقتك من الشريط اللي بيظهر في الموقع. لو رفضت، مفيش حاجة منها بتشتغل ولسه تقدر تتسوق عادي.'
            : 'الأدوات دي بتشتغل لما بتفتح الموقع.',
          'مبنبعتش اسمك ولا رقمك ولا عنوانك لمنصات الإعلانات.',
        ].join('\n')
      : ['ملفات تعريف الارتباط وأدوات الإعلانات', 'الموقع حاليًا مش بيستخدم أدوات قياس إعلانات. السلة بتتحفظ على جهازك بس.'].join('\n'),
  );
  sections.push(
    ['مين بيشوف بياناتك', 'بياناتك مبنبيعهاش. العنوان ورقم التليفون بس بيوصلوا للي بيوصّل طلبك، وبنحتفظ بسجلات الطلبات طول ما القانون والمحاسبة محتاجينها.'].join('\n'),
  );
  sections.push(
    [
      'إزاي تطلب مسح بياناتك أو تعديلها',
      reach.length
        ? `ابعتلنا على ${channels || 'بيانات التواصل فوق'} واكتب إنك عايز تمسح أو تعدّل بياناتك أو حسابك، وإحنا هننفّذ الطلب بعد ما نتأكد إنك صاحب البيانات. السجلات اللي القانون أو المحاسبة بتلزمنا نحتفظ بيها مش بتتمسح.`
        : 'كلّمنا بأي وسيلة تواصل موجودة في الموقع واكتب إنك عايز تمسح أو تعدّل بياناتك أو حسابك، وإحنا هننفّذ الطلب بعد ما نتأكد إنك صاحب البيانات.',
    ].join('\n'),
  );
  sections.push('لو غيّرنا السياسة دي هننشر النسخة الجديدة في الصفحة دي.');
  return sections.join('\n\n');
};
