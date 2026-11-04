# Prompts تنضيف النسخة الأوفلاين — لـ Claude Code

## طريقة الاستخدام
1. افتح Claude Code في فولدر `dafer-offline`.
2. ابعت **Prompt 0** الأول، وده بيعمل ملف الخطة جوه الـ repo.
3. بعدها ابعت كل مرحلة في رسالة لوحدها، **وما تبدأش المرحلة اللي بعدها غير لما:**
   - تشغّل التطبيق بنفسك وتجرّبه
   - تعمل commit
4. يُفضّل تبدأ كل مرحلة بـ `/clear` عشان السياق يبقى نضيف، لأن كل prompt بيقول لـ Claude Code يقرا ملف الخطة.
5. لو Claude Code سألك سؤال أو قالك إن فيه حاجة مش زي ما الخطة متوقعة، جاوبه قبل ما تكمّل.

---

## Prompt 0 — ملف الخطة والسياق

```
اعمل branch جديد اسمه offline-cleanup من الـ branch الحالي.

بعدين اعمل ملف docs/OFFLINE_PLAN.md وحط فيه المحتوى ده بالظبط. ده المرجع الثابت لكل المراحل الجاية:

# Offline Edition Plan

## السياق
- الـ repo ده نسخة أوفلاين مستقلة (منتج عام هيتباع لمحلات كتير). مفيهاش موقع ولا موبايل ولا Firebase.
- الجهاز الرئيسي بيشغّل MongoDB مدمج والـ backend، والأجهزة التانية بتتصل بيه على الشبكة الداخلية عن طريق Electron (electron-offline).
- الـ backend: Express + Mongoose (kapomatic-backend). الـ frontend: Angular standalone (kapomatic-frontend).
- النسخة الأونلاين الكاملة repo تاني، ومش هنلمسها.

## قواعد عامة لأي تعديل
- ما تغيّرش أي منطق في البيع والآجل والمرتجعات والمخزون غير الأسطر المرتبطة بالموقع أو Firebase بس.
- ما تعملش refactor أو تحسينات جانبية. لو شفت حاجة محتاجة تتصلح، اكتبها في آخر الرد بدل ما تصلحها.
- كل مرحلة تخلص بـ: tests الـ backend (npm test)، و npm run build:offline، و npm run test:offline، ومراجعة grep.
- ما تعملش commit لوحدك، أنا هعمل commit بعد ما أجرّب.

## خطة التنضيف
1. شيل Firebase والإشعارات.
2. شيل الموقع من الـ backend (طلبات الموقع، صور الموقع، الصفحات العامة، SEO، الكارت).
3. شيل الإعدادات (المتجر، الشحن، الإعدادات العامة) وحط مكانها "بيانات المحل" (ShopProfile).
4. شيل الموقع من الـ frontend.
5. سكريبت يشتغل مرة واحدة وينضّف الداتا القديمة من الداتابيز.

## قرارات متفق عليها للمراحل الجاية (بعد التنضيف)

### المستخدمين والصلاحيات
- موديل User: اسم، username، كلمة سر bcrypt، دور، قائمة صلاحيات، isActive. الدخول بـ JWT، والـ secret يتولّد على الجهاز الرئيسي ويتحفظ في secret-store.
- الصلاحيات تفصيلية (زي sales.cancel و products.viewCost)، والأدوار قوالب جاهزة: مالك، مدير، كاشير، أمين مخزن، محاسب. المالك يقدر يعدّل صلاحيات أي حد.
- الحماية في الـ backend: middleware اسمه requirePermission على كل route. وسعر الشراء والربح يتشالوا من الـ response للي ما عندوش products.viewCost.
- كل /api وراه login (فيما عدا login و /api/lan). مفيش routes عامة.
- createdBy و updatedBy على كل فاتورة وقيد، مع سجل للعمليات الحساسة.
- حساب المالك يتعمل في معالج الإعداد على الجهاز الرئيسي، ومعاه كود استرجاع.
- رسالة منع البيع بأقل من سعر الشراء ما تكشفش سعر الشراء.

### الحسابات (القيد المزدوج)
- MongoDB يشتغل replica set بعضو واحد عشان transactions. الفاتورة وقيدها يتحفظوا مع بعض أو ما يتحفظش ولا واحد.
- القيود بتتعمل أوتوماتيك من البيع الكاش والآجل والدفعات والمرتجعات والخصم والمشتريات والمصروفات.
- القيد المرحّل ما يتعدّلش ولا يتمسح. التعديل = قيد عكسي + قيد جديد. ومسح الفاتورة يبقى إلغاء (الحالة ملغاة) بقيد عكسي.
- البداية برصيد افتتاحي مش بقيود بأثر رجعي: المخزون (الكمية × سعر الشراء)، وأرصدة العملاء من الآجل، والصندوق والموردين يدخلهم المستخدم، والفرق يروح رأس المال.
- التكملة الأوتوماتيك للمخزون في تعديل الفاتورة تتسجل "تسوية مخزون" لحد ما المشتريات تتعمل، وبعدها تتلغي.
- إقفال فترات اختياري، وبعد الإقفال ما ينفعش تعديل. sync-purchase-price يتمنع في الفترات المقفولة، ويعمل قيد تسوية في المفتوحة.
- خزائن وطرق دفع متعددة (البداية خزنة واحدة)، مع إقفال وردية بيسجّل العجز والزيادة.
- طبقتين: واجهة بسيطة (مصروفات، تحصيل، سداد، تقارير ربح وخزنة وأرصدة)، وطبقة محاسبية بصلاحية (دليل حسابات، قيد يدوي، ميزان مراجعة، قائمة دخل، ميزانية).
- ضريبة القيمة المضافة إعداد اختياري لكل محل، وتتسجل في حساب ضريبة مستحقة. الفاتورة الإلكترونية مرحلة بعدين.
- الفلوس تتقرّب لـ 2 رقم عشري في القيود.

ما تعملش أي تعديل تاني غير الملف ده والـ branch.
```

---

## Prompt 1 — شيل Firebase

```
اقرا docs/OFFLINE_PLAN.md الأول.

المهمة: المرحلة 1، شيل Firebase والإشعارات من kapomatic-backend.

1. ابحث بـ grep في kapomatic-backend و kapomatic-frontend عن: firebase, pushNotification, notifyNewWebsiteOrder, deviceToken, DeviceToken, notificationsApiKey, /notifications. اعرضلي اللي لقيته قبل ما تمسح.
2. امسح:
   - src/services/pushNotification.service.js
   - src/controllers/notification.controller.js
   - src/routes/notification.routes.js
   - src/models/deviceToken.model.js
   - src/middlewares/notificationsApiKey.middleware.js
   - test/notifications.test.js
3. في src/app.js: شيل import الـ notificationRoutes، وشيل بلوك if (!lanMode) بتاع الإشعارات.
4. في src/controllers/selling.controller.js: شيل import الـ notifyNewWebsiteOrder وسطر setImmediate(() => notifyNewWebsiteOrder(order)) بس. باقي checkoutCart هيتشال في المرحلة 2.
5. شيل firebase-admin من package.json وحدّث package-lock.json بـ npm uninstall firebase-admin.
6. شيل أي متغيرات Firebase من .env.example و README.md.
7. في kapomatic-frontend/scripts/offline/stage.js: شيل 'firebase-admin' من BACKEND_EXCLUDED_DEPENDENCIES و 'node_modules/firebase-admin' من FORBIDDEN_BACKEND_PATHS. سيب فحص ملفات firebase-adminsdk / service-account زي ما هو كأمان. ولو فيه test في electron-offline/test بيعتمد على ده، عدّله.
8. في electron-offline/lib/backend-manager.js الكومنت اللي بيذكر Firebase عدّله بس، من غير ما تغيّر الكود.

التأكد:
- cd kapomatic-backend && npm test
- cd kapomatic-frontend && npm run test:offline
- grep -ri "firebase" على الاتنين ما عدا node_modules و package-lock: المفروض ما يطلعش غير فحص ملفات service-account في stage.js.

في الآخر اعرضلي ملخص بالملفات اللي اتمسحت والملفات اللي اتعدّلت.
```

**جرّب بعدها:** `npm run electron:start:offline`، وابيع فاتورة كاش. لو تمام، اعمل commit: `chore(offline): remove Firebase and push notifications`

---

## Prompt 2 — شيل الموقع من الـ backend

```
اقرا docs/OFFLINE_PLAN.md الأول.

المهمة: المرحلة 2، شيل كل كود الموقع من kapomatic-backend. المرحلة دي فيها ملفات أساسية (البيع والمنتجات والفئات)، فاشتغل بحرص.

ابدأ بـ plan mode. اقرا الملفات واعرضلي الخطة بالأسطر اللي هتتشال من كل ملف أساسي قبل ما تعدّل أي حاجة.

أ) امسح بالكامل:
- controllers: websiteOrder, websiteImage, publicPage, publicSeo
- routes: websiteOrder, websiteImage, publicPage, publicSeo, seo, cart
- models: websiteOrder, websiteImage
- services: publicCatalog.service.js
- utils: publicPerformance, publicCacheInvalidation, seo, orderPayment, decodeImage
- tests: public-home-categories, public-optimizations, public-page, public-product-search, public-sitemap-xml, seo-utils, website-image-asset
- docs/home-slider-image-diagnosis.md
- لو فيه controller أو route للـ seo بيتعامل مع حاجة غير الموقع، قولي قبل ما تمسحه.

ب) src/app.js: شيل imports و app.use بتوع كل الـ routes اللي فوق.
ملحوظة: ecommerceSetting هيتشال في المرحلة 3، فسيبه دلوقتي.

ج) src/controllers/selling.controller.js:
- شيل checkoutCart و buildWebsiteOrderItems وأي helper ما بقاش حد بيستخدمه بعدهم، وشيلهم من module.exports.
- شيل import الـ WebsiteOrder و normalizeCheckoutPayment.
- في addSellingRefund شيل بلوك await WebsiteOrder.updateOne(...) بس.
- ShippingSetting: لو ما بقاش مستخدم غير في checkoutCart، شيل الـ import. لو مستخدم في حتة تانية، قولي.
- ما تلمسش createSellingInvoice ولا applyInventoryForInvoiceChange ولا updateSelling ولا الحسابات.

د) product و category (الـ controllers والـ models):
- شيل normalizeSeoInput و clearPublicSeoCache و addSlugAliasesForChangedSlugs، وأي تعامل مع translations و seo و slugAliases.
- في الـ models شيل الحقول translations و seo و slugAliases، والـ indexes بتاعتهم، و attachPublicCacheInvalidation.
- خلي بالك: لو اسم المنتج أو الفئة بيتقري من translations.ar.name في أي مكان كـ fallback، خليه يستخدم name مباشرة وقولي.
- categoryImportExport (service و helper و controller): شيل أعمدة SEO/translations لو موجودة، وتأكد إن الاستيراد والتصدير لسه شغالين بنفس الأعمدة الأساسية.
- سيب isBase64Image و productPricing و invoicePricing.

هـ) Postman collection: شيل الـ requests بتاعة الـ routes اللي اتمسحت.

التأكد:
- npm test (lan-mode.test.js لازم يعدّي).
- node -e "require('./src/app')" من غير errors.
- grep على: websiteOrder, WebsiteOrder, websiteImage, publicSeo, publicPage, checkout, slugAliases, translations, clearPublicSeoCache, normalizeSeoInput. المفروض يطلع فاضي، أو يطلع ecommerceSetting بس وده هيتشال في المرحلة الجاية.
- اعرضلي قايمة بأي حاجة غريبة لقيتها ومحتاجة قرار مني.
```

**جرّب بعدها:** إضافة فئة ومنتج وتعديلهم، بيع كاش، بيع آجل مع دفعة، مرتجع كاش ومرتجع آجل، تعديل فاتورة، ومسح فاتورة، وتصدير المنتجات واستيراد الفئات من Excel. لو تمام: `refactor(offline): remove website backend code`

> الـ frontend هيفضل فيه شاشات بتنادي routes اتمسحت، بس هي متخبية أصلًا في الأوفلاين، فمش مشكلة لحد المرحلة 4.

---

## Prompt 3 — الإعدادات و"بيانات المحل"

```
اقرا docs/OFFLINE_PLAN.md الأول.

المهمة: المرحلة 3.

أ) الشيل من kapomatic-backend:
- models و controllers و routes بتوع ecommerceSetting و shippingSetting و generalSetting.
- شيل app.use("/api/ecommerce-settings") من app.js.
- شيل أي import ليهم من باقي الملفات (category.controller وغيره). ابحث بـ grep الأول واعرضلي الأماكن.

ب) موديل جديد ShopProfile (src/models/shopProfile.model.js)، document واحد بس بـ key: "default" زي ستايل الموديلات الموجودة:
- name: String، إجباري، max 150
- address: String، اختياري، max 500
- phones: [String]، اختياري
- logo: String base64 اختياري، ويتأكد منه بـ isBase64Image
- taxNumber: String، اختياري
- commercialRegister: String، اختياري
- invoiceFooter: String، اختياري، max 500 (زي "البضاعة المباعة لا ترد بعد 14 يوم")
- timestamps
رسائل الـ validation بالعربي زي باقي الموديلات.

ج) routes جديدة /api/shop-profile:
- GET: يرجّع الـ document، أو object فاضي فيه name: "" لو مش موجود.
- PUT: upsert.
استخدم asyncHandler وستايل الـ controllers الموجودة. ضيف test بسيط بنفس ستايل الـ tests الموجودة.

د) في kapomatic-frontend:
- service جديد shop-profile.service.ts.
- شاشة "بيانات المحل" (route: /shop-profile) بنفس ستايل الشاشات الموجودة (PrimeNG/Material، والترجمة، والوضع الليلي، والـ RTL)، فيها فورم ورفع لوجو مع preview.
- ضيفها في القائمة الجانبية، ومفاتيح الترجمة في ar.json و en.json (الاتنين: public/i18n و src/assets/i18n لو الاتنين مستخدمين، تأكد مين فيهم المستخدم فعلًا).
- اربطها بالطباعة: invoice-history-print.util.ts و credit-invoice-print.util.ts. الهيدر يعرض اللوجو والاسم والعنوان والتليفونات والرقم الضريبي (لو موجودين)، والفوتر يعرض invoiceFooter. لو مفيش بيانات محل، الطباعة تفضل شغالة زي دلوقتي.

التأكد:
- npm test في الـ backend
- npm run build:offline
- grep على ecommerceSetting, EcommerceSetting, shippingSetting, ShippingSetting, generalSetting, GeneralSetting في الـ backend: المفروض فاضي.
```

**جرّب بعدها:** املا بيانات المحل، واطبع فاتورة كاش وفاتورة آجل، وجرّب من جهاز تاني على الشبكة لو متاح. لو تمام: `feat(offline): replace website settings with shop profile`

---

## Prompt 4 — شيل الموقع من الـ frontend

```
اقرا docs/OFFLINE_PLAN.md الأول.

المهمة: المرحلة 4، شيل كل كود الموقع من kapomatic-frontend. ابدأ بـ plan mode واعرضلي الخطة.

أ) امسح:
- src/app/modules/seo
- src/app/modules/ecommerce-settings
- src/app/modules/website-images
- src/app/modules/website-orders
- src/app/core/guards/website-feature.guard.ts
- الـ routes بتاعتهم من app.routes.ts

ب) شيل isWebsiteEnabled و websiteEnabled وكل اللي بيعتمد عليهم من:
- layout/custom-sidenav (الـ ts والـ html): فورم الـ SEO في إضافة/تعديل الفئة، و WEBSITE_ONLY_ROUTES، والعناصر بتاعة ecommerce-settings و website-images، و buildSeoFormValue و normalizeSeoExtensionPayload.
- category/add-product، و category/product-edit، و category/category-details: حقول وتابات SEO/translations، ونضّف الـ payload اللي بيتبعت للـ backend من الحقول دي.
- layout/home: زرار ونافيجيشن website-orders، وأي لينكات واتساب خاصة بالموقع.
- products/invoice-history: أي فلتر أو عمود خاص بطلبات الموقع.
- core/runtime/app-features.ts: شيل isWebsiteEnabled وسيب isOfflineMainPc.
- environments (كل الملفات و environment.model.ts): شيل features.website. ولو features بقى فاضي، شيله كله لو ده مش هيكسر حاجة.
- category service: شيل أي methods بتنادي endpoints اتمسحت.

ج) الترجمة: شيل المفاتيح اللي ما بقاش حد بيستخدمها (seo, ecommerce, website, shipping, whatsapp...) من ar.json و en.json. اتأكد بـ grep إن المفتاح مش مستخدم قبل ما تمسحه.

د) الأصول: لو فيه صور أو SVG ما بقاش حد بيستخدمها خالص بعد المسح، اعرضهالي بس من غير ما تمسح.

هـ) الملفات بتاعة النسخة الأونلاين/الديسكتوب القديمة (electron/ و electron:build:win و environment.prod و SSR): ما تمسحهاش في المرحلة دي، بس اعملي قايمة بيها ورأيك هل لسه ليها لازمة في الـ repo ده.

التأكد:
- npm run build:offline من غير errors ولا warnings جديدة
- npm run test:offline
- grep -ri على src/app: website, seo, ecommerce, isWebsiteEnabled, slug, translations. المفروض فاضي، ما عدا translation.service و TranslatePipe بتوع الترجمة نفسها.
```

**جرّب بعدها:** افتح كل شاشة في القائمة بالعربي والإنجليزي وفي الوضع الليلي، وضيف فئة ومنتج وعدّلهم. لو تمام: `refactor(offline): remove website frontend code`

---

## Prompt 5 — تنضيف الداتا القديمة

```
اقرا docs/OFFLINE_PLAN.md الأول.

المهمة: المرحلة 5، تنضيف الداتا القديمة عند المحلات اللي شغالة بالفعل.

اعمل migration يشتغل مرة واحدة عند تشغيل الـ backend:
1. اعمل collection اسمها migrations فيها { name, appliedAt }، و runner بسيط في src/migrations/ بيشغّل أي migration لسه ما اشتغلتش بالترتيب، ويشتغل في server.js بعد الاتصال بالداتابيز وقبل ما السيرفر يبدأ يسمع.
2. أول migration اسمها 001-remove-website-data:
   - تمسح الـ collections دي لو موجودة: websiteorders, websiteimages, devicetokens, ecommercesettings, shippingsettings, generalsettings (اتأكد من الأسماء الفعلية من الموديلات القديمة في git history).
   - تمسح الـ indexes بتاعة translations.ar.slug و translations.en.slug و slugAliases من products و categories لو موجودة.
   - تعمل $unset للحقول translations و seo و slugAliases من products و categories.
   - لو generalsettings فيها document، انقل name والعنوان التفصيلي للـ shopprofiles قبل المسح، لو مفيش ShopProfile موجود.
3. لازم تكون idempotent: لو اشتغلت مرتين ما تكسرش حاجة. وأي خطأ يتسجل في الـ logger ويوقف السيرفر من غير ما يمسح الداتا جزئيًا.
4. الأهم: قبل ما الـ migration تشتغل لأول مرة، تأكد إن فيه نسخة احتياطية. شوف electron-offline/lib/backup-service.js وقولي إزاي أفضل نعمل backup أوتوماتيك قبل أي migration. ما تنفذش الجزء ده قبل ما توريني الاقتراح.
5. اكتب test للـ runner وللـ migration.

التأكد:
- npm test
- جرّب على نسخة من داتابيز فيها داتا من النسخة القديمة لو متاحة.
```

**جرّب بعدها:** خد نسخة احتياطية من داتا حقيقية، وشغّل النسخة الجديدة عليها، وتأكد إن المنتجات والفواتير والعملاء كلهم سليمين. لو تمام: `feat(offline): one-time migration to clean website data`

---

## Prompt 6 — مراجعة نهائية

```
اقرا docs/OFFLINE_PLAN.md الأول.

اعمل مراجعة نهائية للـ branch offline-cleanup مقارنة بالـ branch الأصلي (git diff):
1. أي تغيير في منطق البيع أو الآجل أو المرتجعات أو المخزون مش مرتبط بالموقع أو Firebase؟ اعرضه سطر بسطر.
2. أي import لملف اتمسح، أو export ما بقاش حد بيستخدمه، أو كود ميت فضل بعد المسح؟
3. هل كل الـ routes الباقية في app.js مستخدمة من الـ frontend؟ اعملي جدول: route ← الشاشة اللي بتستخدمه. ده هيبقى أساس شغل الصلاحيات.
4. شغّل npm test و npm run build:offline و npm run test:offline واعرضلي النتيجة.
5. حدّث README.md للـ backend والـ frontend بحيث ما يذكروش الموقع أو Firebase.
6. اكتب وصف الـ pull request بالعربي: إيه اللي اتشال، وإيه اللي اتضاف (بيانات المحل والـ migration)، وإزاي تجرّبه.
```

بعدها اعمل `npm run electron:build:win:offline`، وسطّب النسخة على جهاز نضيف، واعمل merge.
