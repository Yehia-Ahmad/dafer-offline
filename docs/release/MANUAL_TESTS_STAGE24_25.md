# Manual tests, Stages 24 and 25

Things no automated test can prove: a real installer, a real Windows, a real printer. Do the **High** rows on a clean PC (or VM) for every release, the rest when the area changed. "Owner" = the owner account, "Cashier" = a cashier, "Tech" = whoever installs. Mark each row pass / fail with the date and the version.

| # | Case | User | Steps | Expected | Priority |
|---|---|---|---|---|---|
| 1 | Clean install, Arabic | Tech | Run `Nota-Setup-<v>.exe` on a PC that never had Nota. Windows Arabic or pick **العربية** in the language picker. | Picker shows Arabic and English. All installer text in Arabic, right-to-left. SmartScreen warning only if unsigned (More info → Run anyway). Shortcut on desktop and Start menu. | High |
| 2 | Clean install, English | Tech | Same, pick **English**. | All installer text English, including the VC++ and firewall error texts if they appear. | Medium |
| 3 | Installer SHA-256 | Tech | `certutil -hashfile Nota-Setup-<v>.exe SHA256`. | Equals the `.sha256` file. | High |
| 4 | EULA, first run | Owner | Open Nota the first time. | License agreement (Arabic/English) shows; Decline quits; Accept continues; not asked again. | High |
| 5 | Activation | Owner | Copy the Machine ID, issue a license, paste it. | Activated; the shop name is the licensed name. A license made for another PC, a changed character, a test-key license: refused with a clear message. | High |
| 6 | First-run setup | Owner | Set up as main PC, create the owner, record the recovery code. | App opens on the home page. Login footer shows the version. | High |
| 7 | A sale and a receipt | Cashier | Cash sale; print the receipt on the real printer. | Receipt prints inside the paper; Arabic and numbers right. | High |
| 8 | Backup now and restore | Owner | Backup page: back up to a USB stick; change data; restore (password asked). | Data returns to the backup state; everyone is asked to sign in again. | High |
| 9 | Daily backup time and folder | Owner | Backup page: set the daily time a few minutes ahead; choose the USB stick as the daily folder. | A `nota-auto-backup-…` file appears there at that time. Unplug the stick: the next day's backup goes to the program folder and the page says so. | Medium |
| 10 | No-backup reminder | Owner | On a test PC, set the Windows date 4 days ahead with no backup (or use an old data folder). | Home page shows the reminder with "Back up now"; after a backup it disappears. A cashier does not see it. | Medium |
| 11 | Upgrade over the previous version | Tech | Install the new version over the old one **with data**. | Old app stopped cleanly; data intact; `before-upgrade-…` file in `C:\ProgramData\Nota\backups`; the "what's new" window shows once, in the chosen language; About shows the new version and build. | High |
| 12 | Upgrade backup fails | Tech | Fill the disk (or make `backups` read-only) and open the new version. | Startup stops with an Arabic + English message; data unchanged; works after freeing space. | Medium |
| 13 | Older Nota on newer data | Tech | Put an older build on data that a newer one upgraded. | Refuses to open: "needs a newer Nota" (Arabic + English); no data change. | Medium |
| 14 | Rollback | Tech | `FIRST_SHOP_UPGRADE_AR.md`, method A then method B, on a throwaway copy. | Old data and version back; sales made before the upgrade present. | High |
| 15 | Uninstall keeps data | Owner | Uninstall; leave the data box unticked. | `C:\ProgramData\Nota` still there; reinstall finds the data, license and users. | High |
| 16 | Uninstall deletes data | Owner | Uninstall; tick "Also delete all my data". | A second question appears (default **No**). No → stays on the page, nothing deleted. Yes → `C:\ProgramData\Nota` removed. Silent uninstall (`/S`) never deletes. | High |
| 17 | Diagnostics file | Owner/Manager | Settings → About → Export diagnostics file. | Save dialog; file `nota-diagnostics-<licenseId>-<date>.zip`; opens in Windows; no passwords, tokens, license text, phone numbers or e-mails inside; no shop data. A cashier does not see the button. | High |
| 18 | Client PC | Tech | Install on a second PC as client; pair it. | Connects; a different version on the client shows the warning; license client limit enforced. | High |
| 19 | Firewall | Tech | Second PC reaches the main PC without touching Windows Firewall. | Works on a "Public" network profile too. | Medium |
| 20 | Calibration sheet | Tech | `PRINTER_CHECK_AR.md` on the real 80 mm printer. | Ruler reads 0–80 mm; a width (72/76/80) and an offset can be chosen so margins are equal; barcode scans; cut line at the cutter. | High |
| 21 | Width/offset on all receipts | Cashier | After calibrating, print a sale receipt, a return, a payment receipt, a shift close. | All use the same width and shift. A4 invoices unchanged. | Medium |
| 22 | Start with Windows / tray | Owner | Restart Windows. | Nota starts in the tray; second Windows account can open it; quit-all stops the database cleanly. | Medium |
| 23 | Slow first start (Defender on) | Tech | Cold start right after install on a PC with Defender on. | The window appears; note the seconds. (The backend is 13 files, not 4,000.) | Medium |
| 24 | Install over a kept-data install | Tech | After case 15, install again. | Existing shop opens normally, no setup screen. | Medium |
| 25 | Language switch | Owner | Switch the app to English. | About, backup reminder, what's-new text, calibration sheet and diagnostics texts all English and left-to-right. | Low |
