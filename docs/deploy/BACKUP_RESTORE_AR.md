# النسخ الاحتياطي والاستعادة

## أين النسخ؟
- يومياً الساعة **03:30 بتوقيت القاهرة** يعمل `nota-backup.timer` وينتج `/var/backups/nota/nota-YYYY-MM-DD-HHMM.archive.gz`.
- بعد كل نسخة يتم التحقق أن الملف قابل للقراءة. يُحفظ آخر **14** نسخة يومية على السيرفر. النسخ `before-update-*` و `before-restore-*` تُحفظ آخر 10 منها.
- النتيجة والسجل: `# systemctl status nota-backup` و `# journalctl -u nota-backup -n 50 --no-pager`. لو فشلت النسخة تظهر الحالة failed.
- تشغيل نسخة الآن يدوياً: `# /opt/nota/bin/backup.sh` (تطبع مسار الملف).
- **نسخة على نفس السيرفر لا تكفي**: لو ضاع السيرفر ضاعت معه. اضبط النسخ خارج السيرفر (التالي). بدونه يكتب السكربت تحذيراً كل يوم.

## نسخة خارج السيرفر (rclone مع Google Drive)
الإعداد يتم على السيرفر ولا يوضع أي شيء منه في git.
- `setup-server.sh` يثبّت rclone بالمثبّت الرسمي من rclone.org (وليس من apt لأن نسخته قديمة). تأكد: `# rclone version`.
- لتحديث rclone لاحقاً: `# curl -fsSL https://rclone.org/install.sh | bash`
- لو لم يكن مثبتاً لأي سبب، ثبّته بنفس الأمر (يحتاج `unzip`: `# apt-get install -y unzip`).

1. `# rclone config` ثم:
   - `n` (new remote)، الاسم: `gdrive`، النوع: `drive` (Google Drive).
   - اترك client_id و client_secret فارغين، و scope = `1` (full access) أو `3` (drive.file).
   - عند سؤال "Use web browser to automatically authenticate": اختر **n** (السيرفر بلا متصفح).
   - سيعرض أمراً مثل `rclone authorize "drive" "..."`: شغّله **على جهازك Windows** (بعد تثبيت rclone من rclone.org)، سجّل دخول Google، ثم انسخ النتيجة (token) والصقها في السيرفر.
   - اختر "Configure as Shared Drive": n، ثم y لحفظ.
2. اختبر: `# rclone mkdir gdrive:nota-backups && rclone lsd gdrive:`
3. فعّل: افتح `# nano /etc/nota/backup.env` واكتب `NOTA_RCLONE_REMOTE=gdrive:nota-backups`
4. جرّب: `# /opt/nota/bin/backup.sh` ثم `# rclone ls gdrive:nota-backups` يجب أن ترى الملف.
- يُحفظ آخر **30** نسخة هناك. ملف الإعداد في `/root/.config/rclone/rclone.conf` (سري؛ لا ترفعه).
- (Backblaze B2 أيضاً مدعوم: `rclone config` ثم النوع `b2`، وضع `NOTA_RCLONE_REMOTE=b2:bucket/nota`.)

## تجربة الاستعادة (افعلها مرة بعد أول إعداد)
الهدف أن تتأكد أن النسخة تُقرأ فعلاً دون المساس بالبيانات الحالية:
```
# ls -lh /var/backups/nota
# URI=$(grep '^MONGO_URI=' /etc/nota/backend.env | cut -d= -f2-)
# mongorestore --uri="$URI" --archive=/var/backups/nota/<الملف> --gzip --dryRun
```
(`--dryRun` لا يكتب شيئاً.) ولاختبار كامل يُفضَّل تنفيذ الاستعادة الحقيقية على سيرفر تجريبي.

## الاستعادة الحقيقية
> **تحذير:** تستبدل كل بيانات المحل بالنسخة، وكل ما أُدخل بعدها يضيع، ويضطر كل المستخدمين لتسجيل الدخول من جديد.

1. (من نسخة خارجية فقط) نزّل الملف للسيرفر: `# rclone copy gdrive:nota-backups/<الملف> /root/`
2. شغّل: `# /opt/nota/bin/restore.sh /var/backups/nota/<الملف>` (أو `/root/<الملف>`)
3. اكتب الدومين لتأكيد العملية.
4. يفعل السكربت: نسخة أمان `before-restore-*` أولاً ← إيقاف الخدمة ← `mongorestore --drop` ← تحديث `NOTA_SESSIONS_VALID_AFTER` ليسجّل الجميع الدخول من جديد ← تشغيل الخدمة ← انتظار `/health`.
5. تأكد: `# curl -s http://127.0.0.1:5000/health` ثم افتح الموقع وراجع البيانات.
6. لو أخطأت في اختيار النسخة: نسخة الأمان `before-restore-*` في `/var/backups/nota` وتستطيع استعادتها بنفس الطريقة.

## ضياع السيرفر بالكامل
1. جهّز سيرفراً جديداً بـ `NEW_SERVER_AR.md` (نفس الدومين بعد تغيير سجل A).
2. نزّل آخر نسخة من Google Drive وضعها في `/root/`.
3. ارفع إصداراً (`UPDATE_AR.md`)، ثم `restore.sh` بالنسخة. لا تنشئ مالكاً جديداً: الحسابات في النسخة.
