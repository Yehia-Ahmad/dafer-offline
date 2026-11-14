'use strict';

// Arabic labels for the app state, shared by the tray menu and the status page.

const LABELS = {
  starting: 'جاري تشغيل الخادم...',
  running: 'الخادم يعمل',
  restarting: 'جاري إعادة تشغيل الخادم...',
  stopping: 'جاري إيقاف الخادم...',
  failed: 'الخادم متوقف بسبب خطأ',
  attached: 'الخادم يعمل من حساب Windows آخر',
  'not-configured': 'لم يتم إعداد البرنامج بعد',
  setup: 'إعداد الجهاز',
  connecting: 'جاري الاتصال بالجهاز الرئيسي...',
  connected: 'متصل بالجهاز الرئيسي',
  unreachable: 'لا يوجد اتصال بالجهاز الرئيسي',
  unauthorized: 'كلمة سر الشبكة غير صحيحة',
  'not-nota': 'العنوان لا يخص جهازاً رئيسياً',
  'not-activated': 'الجهاز الرئيسي غير مفعّل',
  activation: 'تفعيل الترخيص',
  damaged: 'التثبيت تالف',
  eula: 'اتفاقية الترخيص',
};

// The server pauses briefly for each of these (supervisor.runMaintenance).
const MAINTENANCE_LABELS = {
  backup: 'جاري إنشاء نسخة احتياطية، الخادم متوقف لثوانٍ',
  'auto-backup': 'جاري إنشاء النسخة الاحتياطية اليومية، الخادم متوقف لثوانٍ',
  restore: 'جاري استعادة نسخة احتياطية، الخادم متوقف مؤقتاً',
};

function statusLabel(status) {
  if (status && status.state === 'maintenance') return MAINTENANCE_LABELS[status.reason] || MAINTENANCE_LABELS.restore;
  return LABELS[status && status.state] || 'الخادم متوقف';
}

module.exports = { statusLabel };
