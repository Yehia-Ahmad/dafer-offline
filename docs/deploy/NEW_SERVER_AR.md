# تجهيز سيرفر جديد لمحل (خطوة بخطوة)

كل محل = سيرفر VPS واحد + دومين واحد. المطلوب: Ubuntu 24.04 LTS، صلاحية root عبر SSH.
كل الأوامر التي تبدأ بـ `PS>` تُنفَّذ في PowerShell على جهازك (Windows)، والتي تبدأ بـ `#` تُنفَّذ على السيرفر.

## 1) شراء/تجهيز السيرفر
1. اشترِ VPS (مثلاً Contabo) بنظام **Ubuntu 24.04 LTS**، ويُفضَّل 4 GB رام أو أكثر.
2. سجّل عنوان الـ IP وكلمة سر root التي وصلتك.
3. تأكد من الدخول: `PS> ssh root@<IP>` (اكتب yes أول مرة).

## 2) سجل الدومين (DNS)
1. عند مزوّد الدومين أضف سجل **A**: الاسم `shop` (أو الدومين الفرعي الذي تريده) ← القيمة: IP السيرفر.
2. انتظر بضع دقائق. تحقق: `PS> nslookup shop.example.com` يجب أن يرجع IP السيرفر.
3. إذا شغّلت السكربت قبل أن يشير الدومين للسيرفر سيتوقف برسالة واضحة؛ أضف السجل وأعد التشغيل (آمن).

## 3) رفع ملفات النشر وتشغيل الإعداد (مرة واحدة)
من جذر المشروع على جهازك:
```
PS> scp -r deploy root@<IP>:/root/deploy
PS> ssh root@<IP>
# bash /root/deploy/setup-server.sh shop.example.com you@example.com
```
- السكربت يثبّت: MongoDB 8 و Node 24 و nginx و certbot و ufw و fail2ban، ويضبط المنطقة الزمنية `Africa/Cairo`، والتحديثات الأمنية التلقائية.
- يجهّز MongoDB على `127.0.0.1` فقط، بنظام replica set باسم `rs0` وبمصادقة، ويولّد كل كلمات السر والمفاتيح على السيرفر. **لا تُطبع أي كلمة سر** على الشاشة.
- الأسرار محفوظة في `/etc/nota/backend.env` و `/etc/nota/mongo-admin.env` (للـ root فقط). لا تنسخها في أي مكان ولا ترفعها على git.
- يمكن إعادة تشغيل السكربت بأمان لو توقف في منتصفه (لن يغيّر الأسرار الموجودة).
- في النهاية يطبع الخطوات التالية.

## 4) أول إصدار (Release)
على جهازك (يجب أن تكون كل تعديلاتك committed):
```
PS> node deploy/make-release.js
PS> scp release\release-<النسخة>-<الكوميت>.tar.gz root@<IP>:/root/
```
على السيرفر:
```
# /opt/nota/bin/update.sh /root/release-<النسخة>-<الكوميت>.tar.gz
```
(أول مرة لا يوجد نسخة احتياطية قبل التحديث لأنه لا توجد بيانات بعد.)

## 5) إنشاء حساب المالك
```
# nota-owner create --username owner --name "اسم صاحب المحل"
```
سيطلب كلمة السر ثم يطبع **كود الاستعادة مرة واحدة**: احفظه في مكان آمن. (لو نسيت كلمة السر: `nota-owner recover`.)

## 6) مفتاح SSH وإغلاق الدخول بكلمة السر (يدوي عمداً)
> **تحذير:** خطأ هنا قد يقفل عليك السيرفر. لا تغلق نافذة SSH الحالية قبل اختبار الدخول بالمفتاح من نافذة ثانية.

1. على جهازك: `PS> ssh-keygen -t ed25519` (اضغط Enter، ويُفضَّل وضع passphrase).
2. ارفع المفتاح العام: 
   `PS> type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@<IP> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`
3. **افتح نافذة PowerShell ثانية** وجرّب: `PS> ssh root@<IP>` — يجب أن تدخل بالمفتاح دون كلمة سر. إن لم تدخل لا تكمل.
4. فقط بعد نجاح الخطوة 3، على السيرفر (في النافذة الأولى):
   ```
   # nano /etc/ssh/sshd_config.d/99-nota.conf
   ```
   واكتب:
   ```
   PasswordAuthentication no
   PermitRootLogin prohibit-password
   ```
   ثم: `# sshd -t && systemctl reload ssh`
5. من نافذة ثالثة تأكد أن الدخول بالمفتاح ما زال يعمل. احتفظ بنسخة من المفتاح الخاص.

## 7) التأكد أن كل شيء يعمل
```
# systemctl status nota-backend nginx mongod --no-pager
# curl -s http://127.0.0.1:5000/health          # {"ok":true,"version":"...","db":"up"}
# curl -sI https://shop.example.com | head -5    # HTTP/2 200
# systemctl list-timers nota-backup.timer certbot.timer
# ufw status
# journalctl -u nota-backend -n 50 --no-pager
```
ثم افتح `https://shop.example.com` في المتصفح وسجّل الدخول بحساب المالك.
اضبط بعدها النسخ الاحتياطي خارج السيرفر: `BACKUP_RESTORE_AR.md`.

## ملاحظات
- المسارات: الإصدارات في `/opt/nota/releases`، والنسخة الحالية `/opt/nota/current`، والإعدادات `/etc/nota`، والنسخ الاحتياطية `/var/backups/nota`، وملف مفتاح MongoDB في `/etc/mongodb-keyfile`.
- سجل الخدمة: `journalctl -u nota-backend`.
- شهادة HTTPS: يبدأ nginx بإعداد HTTP فقط (مع مسار `/.well-known/acme-challenge/`)، ثم يطلب certbot الشهادة (webroot)، وبعدها فقط يُركَّب إعداد HTTPS. إعادة تشغيل `setup-server.sh` بعد وجود الشهادة آمنة. التجديد التلقائي عبر `certbot.timer`.
- تسجيل الدخول محدود في nginx بـ 10 محاولات في الدقيقة لكل IP (بعدها خطأ 429)، فوق قفل التطبيق نفسه (5 محاولات خاطئة لكل مستخدم + IP). لا يوجد تحديد معدل لباقي الطلبات حالياً.
