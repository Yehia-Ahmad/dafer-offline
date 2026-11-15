# Nota changelog

Every version has a section. The Arabic and English lists are what the "what's new" window shows once after an upgrade
(electron-offline/lib/whats-new.js). The build refuses to release a version that has no section here.

## 1.1.0 - 2026-11-15

### ar
- باركود لكل منتج: سجّل باركود المصنع بالسكانر في صفحة المنتج، أو اضغط «ولّد باركود» ليطلع لك باركود داخلي (يبدأ بـ 2). لحد 5 باركودات للمنتج، ولا يتكرر باركود بين منتجين.
- «ولّد باركود للمنتجات اللي ملهاش» من صفحة المنتجات: يعرض لك العدد الأول ويطلب التأكيد، ثم يضيف باركود لكل منتج ملوش.
- البيع بالسكانر: امسح المنتج في البيع النقدي والآجل والمشتريات فيُضاف بكمية 1، ولو مسحته تاني تزيد الكمية 1. باركود مش متسجل يطلع له تنبيه وصوت، وتقدر تضيفه كمنتج جديد على طول.
- المرتجعات: امسح باركود الإيصال (رقم الفاتورة) فتفتح الفاتورة، وامسح باركود أي منتج فيها فيزيد 1 في كمية المرتجع بحد أقصى المتاح.
- يشتغل السكانر حتى لو الكيبورد على العربي، وبأرقام عربية أو فارسية.
- طباعة ملصقات الباركود (اسم المحل، اسم المنتج، السعر، الباركود، الكود الداخلي) على طابعة ملصقات (رول) بمقاسات 38×25 و40×30 و50×25 و50×30 و58×40 أو مقاس مخصوص، أو على ورق ملصقات A4 (3×7 و3×8 و4×10 و5×13 أو شبكة مخصوصة) مع «ابدأ من الملصق رقم» وورقة اختبار للحدود.
- صلاحية جديدة «طباعة ملصقات الباركود»: المالك والمدير وأمين المخزن عندهم، والكاشير لا. أقصى عدد 2000 ملصق في المرة.
- إعدادات الجهاز: طابعة الملصقات، إزاحة ومسافة بين الملصقات، وكتم أصوات المسح.

### en
- A barcode for every product: scan the factory barcode into the product page, or press "Generate barcode" for an in-store one (it starts with 2). Up to 5 barcodes per product, and no barcode is shared by two products.
- "Generate barcodes for products without one" on the products page: it shows the count first and asks to confirm, then adds a barcode to each product that has none.
- Selling by scanner: scan a product in cash sales, credit sales and purchases and it is added with quantity 1; scan it again and the quantity goes up by 1. An unknown barcode gets a warning and a sound, and can be added as a new product right away.
- Returns: scan the receipt barcode (the invoice number) to open the invoice, and scan any product in it to add 1 to the return quantity, up to what is returnable.
- The scanner works even when the keyboard is on Arabic, and with Arabic or Persian digits.
- Print barcode labels (shop name, product name, price, barcode, internal code) on a label printer (roll) in 38×25, 40×30, 50×25, 50×30, 58×40 or a custom size, or on A4 sticker sheets (3×7, 3×8, 4×10, 5×13 or a custom grid) with "Start at label N" and an outline test sheet.
- New permission "Print barcode labels": owner, manager and storekeeper have it, the cashier does not. At most 2,000 labels per job.
- Device settings: the label printer, offsets and the gap between labels, and muting the scan sounds.

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
