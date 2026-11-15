; NSIS hooks for the offline edition installer (electron-builder.offline.json).
; Saved as UTF-8 WITH a byte order mark: NSIS Unicode reads a file without one as the system code page, which would garble the Arabic text.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "${PROJECT_DIR}\installer-offline\notaData.nsh"

; Firewall rule names: keep in sync with electron-offline/lib/firewall.js and the productName in electron-offline/edition.json.
!define NOTA_RULE_TCP "Nota Server"
!define NOTA_RULE_UDP "Nota Discovery"
; Login item value written by the app (electron-offline/main.js applyLoginItem).
!define NOTA_RUN_VALUE "Nota"

; Defining customCheckAppRunning skips these in electron-builder's template, but its default
; check (_CHECK_APP_RUNNING), used below as the fallback, needs them.
!include "getProcessInfo.nsh"
Var pid

; Stage 25: a message in the language of the installer (Arabic when the user picked Arabic, English otherwise).
!macro notaMessage ar en
  ${If} $LANGUAGE == ${NOTA_LANG_ARABIC}
    MessageBox MB_OK|MB_ICONEXCLAMATION "${ar}" /SD IDOK
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "${en}" /SD IDOK
  ${EndIf}
!macroend

; Before files are replaced or removed (install, upgrade, uninstall). electron-builder's
; default check would kill every process under $INSTDIR, mongod.exe included, which risks the
; database. Instead the running app is asked to stop: "--quit-all" reaches the copy that runs
; the server in any Windows account and returns once mongod has stopped cleanly. The default
; check then closes whatever is left (client or second-account windows, no database).
!macro customCheckAppRunning
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Stopping Nota..."
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-all' $0
    ${If} $0 != 0
      DetailPrint "Nota did not confirm a clean stop (exit code $0)."
    ${EndIf}
  ${EndIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro customInstall
  ; mongod.exe needs the Microsoft Visual C++ 2015-2022 runtime (x64), which a clean
  ; Windows 10 install may not have. The redistributable skips itself when an equal or
  ; newer version is already installed.
  DetailPrint "Installing the Microsoft Visual C++ runtime..."
  File "/oname=$PLUGINSDIR\vc_redist.x64.exe" "${PROJECT_DIR}\vendor\vcredist\vc_redist.x64.exe"
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $0
  Delete "$PLUGINSDIR\vc_redist.x64.exe"
  ; 0 = installed, 1638 = a newer version is already installed, 3010 = installed, restart pending
  ${If} $0 != 0
  ${AndIf} $0 != 1638
  ${AndIf} $0 != 3010
    !insertmacro notaMessage "تعذر تثبيت مكتبة Microsoft Visual C++ التي تحتاجها قاعدة البيانات. رمز الخطأ: $0$\r$\nقد لا يعمل الجهاز الرئيسي حتى يتم تثبيتها." "The Microsoft Visual C++ runtime that the database needs could not be installed. Error code: $0$\r$\nThe main PC may not work until it is installed."
  ${EndIf}

  ; Shared data folder: every Windows account on the PC may modify it, so the main PC works
  ; whoever logs in. BUILTIN\Users by SID, so it works on Arabic and English Windows alike.
  ; The folder and its data are never removed by the uninstaller, unless the owner asks for that (the data page, Stage 25).
  ; Folder name: keep in sync with the productName in electron-offline/edition.json (lib/paths.js).
  ReadEnvStr $1 "ProgramData"
  ${If} $1 == ""
    StrCpy $1 "C:\ProgramData"
  ${EndIf}
  CreateDirectory "$1\Nota"
  DetailPrint "Setting permissions on $1\Nota..."
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$1\Nota" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q'
  Pop $0
  ${If} $0 != 0
    DetailPrint "icacls failed with exit code $0"
  ${EndIf}

  ; Windows Firewall: client PCs reach the backend (TCP) and find the main PC (UDP discovery)
  ; from the local subnet only, on every network profile (a shop LAN without internet is
  ; usually "Public"). Removing the program's old rules first also removes a "block" rule
  ; left by a cancelled Windows Firewall prompt. The rules cover the app's helper processes
  ; (the backend runs inside the same executable); mongod listens on 127.0.0.1 only.
  DetailPrint "Adding Windows Firewall rules..."
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name=all program="$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${NOTA_RULE_TCP}" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=TCP remoteip=localsubnet profile=any enable=yes'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${NOTA_RULE_UDP}" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=UDP remoteip=localsubnet profile=any enable=yes'
  Pop $1
  ${If} $0 != 0
  ${OrIf} $1 != 0
    !insertmacro notaMessage "تعذر إضافة إعدادات جدار حماية Windows. قد لا تتمكن الأجهزة الفرعية من الاتصال بالجهاز الرئيسي." "The Windows Firewall rules could not be added. Client PCs may not be able to reach the main PC."
  ${EndIf}
!macroend

; Stage 25: the uninstaller asks, on its own page after the welcome page, whether to delete ALL the shop's data too. The box is OFF by default;
; ticking it needs a second confirmation (default answer No) before the page can be left. Silent uninstalls and upgrades never delete data.
!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  Var /GLOBAL notaDeleteBox
  Var /GLOBAL notaDeleteChecked
  Var /GLOBAL notaDeleteConfirmed
  UninstPage custom un.notaDataPage un.notaDataPageLeave

  Function un.notaDataPage
    StrCpy $notaDeleteChecked "0"
    StrCpy $notaDeleteConfirmed "0"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${If} $LANGUAGE == ${NOTA_LANG_ARABIC}
      ${NSD_CreateLabel} 0 0 100% 48u "سيتم حذف برنامج نوتة من هذا الجهاز، لكن بيانات المحل (الفواتير والعملاء والنسخ الاحتياطية والترخيص) تبقى محفوظة في C:\ProgramData\Nota لتستخدمها إذا أعدت تثبيت البرنامج."
      Pop $0
      ${NSD_CreateCheckbox} 0 56u 100% 24u "احذف كل بياناتي أيضاً (لا يمكن التراجع)"
    ${Else}
      ${NSD_CreateLabel} 0 0 100% 48u "Nota will be removed from this PC, but the shop's data (invoices, customers, backups and the license) stays in C:\ProgramData\Nota so you can use it if you install Nota again."
      Pop $0
      ${NSD_CreateCheckbox} 0 56u 100% 24u "Also delete all my data (this cannot be undone)"
    ${EndIf}
    Pop $notaDeleteBox
    ; unchecked: the default is to KEEP the data
    ${NSD_SetState} $notaDeleteBox ${BST_UNCHECKED}
    nsDialogs::Show
  FunctionEnd

  Function un.notaDataPageLeave
    ${NSD_GetState} $notaDeleteBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $notaDeleteChecked "1"
      ${If} $LANGUAGE == ${NOTA_LANG_ARABIC}
        MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "تأكيد أخير: سيتم حذف كل بيانات المحل من هذا الجهاز نهائياً (الفواتير والعملاء والحسابات والنسخ الاحتياطية). لا يمكن استرجاعها بعد ذلك إلا من نسخة احتياطية خارج هذا الجهاز.$\r$\n$\r$\nهل تريد حذف كل شيء؟" IDYES nota_confirmed
      ${Else}
        MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Last confirmation: ALL the shop's data (invoices, customers, accounts and backups) will be deleted from this PC for good. It can only be recovered from a backup kept outside this PC.$\r$\n$\r$\nDelete everything?" IDYES nota_confirmed
      ${EndIf}
      ; No: stay on the page, nothing is deleted
      StrCpy $notaDeleteChecked "0"
      Abort
      nota_confirmed:
      StrCpy $notaDeleteConfirmed "1"
    ${EndIf}
  FunctionEnd
!macroend

!macro customUnInstall
  ; An upgrade runs the old uninstaller first; the new installer adds the rules again.
  ${IfNot} ${isUpdated}
    nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name=all program="$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    Pop $0
    ; The "start with Windows" entry of the account running the uninstaller. Other accounts'
    ; entries point at a missing file and are ignored by Windows.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${NOTA_RUN_VALUE}"
  ${EndIf}

  ; Stage 25: delete the shop's data only when the owner asked for it on the data page and confirmed (never during an upgrade or a silent uninstall).
  ; The app was stopped cleanly before this point (customCheckAppRunning), so mongod no longer has the files open.
  StrCpy $R6 "0"
  StrCpy $R7 "0"
  ${If} ${isUpdated}
    StrCpy $R6 "1"
  ${EndIf}
  ${If} ${Silent}
    StrCpy $R7 "1"
  ${EndIf}
  !insertmacro notaDeleteDataDecide $R6 $R7 $notaDeleteChecked $notaDeleteConfirmed $R8
  ${If} $R8 == "1"
    ReadEnvStr $R9 "ProgramData"
    ${If} $R9 == ""
      StrCpy $R9 "C:\ProgramData"
    ${EndIf}
    DetailPrint "Deleting the shop data folder $R9\Nota..."
    !insertmacro notaDeleteDataFolder $R9
  ${EndIf}
!macroend
