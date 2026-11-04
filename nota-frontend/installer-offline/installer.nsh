; NSIS hooks for the offline edition installer (electron-builder.offline.json).

; Firewall rule names: keep in sync with electron-offline/lib/firewall.js and the productName in electron-offline/edition.json.
!define NOTA_RULE_TCP "Nota Server"
!define NOTA_RULE_UDP "Nota Discovery"
; Login item value written by the app (electron-offline/main.js applyLoginItem).
!define NOTA_RUN_VALUE "Nota"

; Defining customCheckAppRunning skips these in electron-builder's template, but its default
; check (_CHECK_APP_RUNNING), used below as the fallback, needs them.
!include "getProcessInfo.nsh"
Var pid

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
    MessageBox MB_OK|MB_ICONEXCLAMATION "تعذر تثبيت مكتبة Microsoft Visual C++ التي تحتاجها قاعدة البيانات. رمز الخطأ: $0$\r$\nقد لا يعمل الجهاز الرئيسي حتى يتم تثبيتها." /SD IDOK
  ${EndIf}

  ; Shared data folder: every Windows account on the PC may modify it, so the main PC works
  ; whoever logs in. BUILTIN\Users by SID, so it works on Arabic and English Windows alike.
  ; The folder and its data are never removed by the uninstaller.
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
    MessageBox MB_OK|MB_ICONEXCLAMATION "تعذر إضافة إعدادات جدار حماية Windows. قد لا تتمكن الأجهزة الفرعية من الاتصال بالجهاز الرئيسي." /SD IDOK
  ${EndIf}
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
!macroend
