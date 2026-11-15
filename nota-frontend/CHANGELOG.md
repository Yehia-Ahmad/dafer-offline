# Nota changelog

Every version has a section. The Arabic and English lists are what the "what's new" window shows once after an upgrade
(electron-offline/lib/whats-new.js). The build refuses to release a version that has no section here.

## 1.0.0 - 2026-11-14

### ar
- أول إصدار جاهز للتسليم: يُثبَّت على أي جهاز ويعمل بدون إنترنت.
- التحديث المستقبلي يحفظ نسخة احتياطية من بياناتك تلقائياً قبل تغيير أي شيء (before-upgrade) ولا يضيّع بياناتك.
- لو فتحت نسخة أقدم على بيانات أحدث، يرفض البرنامج الفتح ويطلب منك أحدث نسخة بدل أن يفسد البيانات.
- صفحة جديدة "عن البرنامج" بها رقم الإصدار، وزر "تصدير ملف التشخيص" لإرساله للدعم الفني دون أي كلمات سر.
- تنبيه في الصفحة الرئيسية إذا مرّت 3 أيام أو أكثر بدون نسخة احتياطية ناجحة، مع زر "انسخ الآن".
- تحديد وقت النسخ الاحتياطي اليومي ومجلده من الإعدادات؛ والنسخة التي فاتها وقتها (البرنامج مغلق) تُؤخذ عند أول تشغيل، وتُؤخذ عند الإغلاق إذا لم تُؤخذ نسخة اليوم.
- ورقة اختبار لطابعة الإيصالات (مسطرة بالمليمتر) وضبط عرض الورق (72 / 76 / 80 مم) وإزاحة الطباعة.
- المثبّت بالعربية والإنجليزية، وعند الإزالة يمكنك اختيار حذف بياناتك (بتأكيد ثانٍ).

### en
- First shippable release: installs on any PC and works with no internet.
- Future upgrades back up your data automatically before changing anything (before-upgrade) and never lose it.
- If an older Nota is opened on newer data, it refuses to start and asks for the newest version instead of damaging the data.
- New "About" page with the version and an "Export diagnostics file" button to send to support, with no passwords inside.
- Home page reminder when 3 or more days pass with no successful backup, with a "Back up now" button.
- Choose the daily backup time and folder in Settings; a backup whose time passed while the program was closed is taken at the next start, and one is taken on close if today's was not taken.
- Receipt printer test sheet (ruler in millimetres), paper width (72 / 76 / 80 mm) and print offset settings.
- The installer speaks Arabic and English, and the uninstaller lets you choose to delete your data (with a second confirmation).
