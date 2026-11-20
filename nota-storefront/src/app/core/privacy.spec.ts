import { hasCustomPrivacy, privacyText, privacyTitle } from './privacy';
import { StoreSettings } from './models';

const base = (extra: Partial<StoreSettings> = {}): StoreSettings => ({
  enabled: true,
  shop: { name: 'النور للأدوات الكهربائية', phones: ['01012345678', '01112345678', '01212345678'], address: '12 شارع الجمهورية، المنصورة' },
  contact: { whatsapp: '201012345678' },
  ...extra,
});

describe('privacy text (Online Stage 7C)', () => {
  it('is generated in Arabic from the shop name, phone and address, and covers what the site collects and how to ask for deletion', () => {
    const text = privacyText(base());
    expect(privacyTitle(base())).toBe('سياسة الخصوصية — النور للأدوات الكهربائية');
    expect(text).toContain('النور للأدوات الكهربائية');
    expect(text).toContain('01012345678');
    expect(text).toContain('01112345678');
    expect(text).not.toContain('01212345678'); // two phones at most
    expect(text).toContain('12 شارع الجمهورية، المنصورة');
    expect(text).toContain('201012345678');
    for (const topic of ['الطلبات', 'الحساب (اختياري)', 'بيانات التواصل (Leads)', 'الزيارات', 'ملفات تعريف الارتباط', 'إزاي تطلب مسح بياناتك']) expect(text).toContain(topic);
    expect(text).toContain('مسح');
    expect(hasCustomPrivacy(base())).toBeFalse();
  });

  it('mentions the pixels only when the shop has set one up, and "after your consent" only when the shop requires consent', () => {
    const none = privacyText(base());
    expect(none).toContain('مش بيستخدم أدوات قياس إعلانات');
    expect(none).not.toContain('Meta');

    const meta = privacyText(base({ marketing: { metaPixelId: '123456789012345', tiktokPixelId: '', requireConsent: true, attributionDays: 7, heardFromOptions: [] } }));
    expect(meta).toContain('فيسبوك وإنستجرام (Meta)');
    expect(meta).not.toContain('تيك توك');
    expect(meta).toContain('بعد موافقتك');

    const both = privacyText(base({ marketing: { metaPixelId: '123456789012345', tiktokPixelId: 'CABC123', requireConsent: false, attributionDays: 7, heardFromOptions: [] } }));
    expect(both).toContain('تيك توك');
    expect(both).not.toContain('بعد موافقتك');
    expect(both).toContain('بتشتغل لما بتفتح الموقع');
  });

  it('works with no phone, address or WhatsApp (never prints "undefined" or an empty contact block) and with no shop name', () => {
    const text = privacyText({ enabled: true });
    expect(text).not.toMatch(/undefined|null/);
    expect(text).not.toContain('للتواصل معانا');
    expect(text).toContain('كلّمنا بأي وسيلة تواصل موجودة في الموقع');
    expect(privacyTitle({ enabled: true })).toBe('سياسة الخصوصية — المتجر');
    expect(privacyText(null)).toContain('المتجر');
  });

  it("the owner's own text replaces it completely (and is used as stored)", () => {
    const own = base({ privacyPolicy: '  سياستنا الخاصة\nمفيش بيانات بتتجمع.  ' });
    expect(hasCustomPrivacy(own)).toBeTrue();
    expect(privacyText(own)).toBe('سياستنا الخاصة\nمفيش بيانات بتتجمع.');
    expect(hasCustomPrivacy(base({ privacyPolicy: '   ' }))).toBeFalse();
    expect(privacyText(base({ privacyPolicy: '   ' }))).toContain('مين إحنا');
  });
});
