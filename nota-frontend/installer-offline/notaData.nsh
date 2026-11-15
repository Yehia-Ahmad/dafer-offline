; Stage 25: the "delete all my data" choice of the uninstaller, as small macros so one NSIS test can run the real decision logic
; (electron-offline/test/stage25-installer.test.js compiles installer-offline/test-uninstall-data.nsi with makensis and runs it).
;
; The data folder is C:\ProgramData\Nota (the shop's database, backups, license, logs). An uninstall keeps it unless the owner ticks the box
; on the uninstaller's data page AND answers Yes to a second, plainly worded question (the default answer is No). Never during an upgrade
; (the old uninstaller runs first), never in a silent uninstall (/S: scripts and our own installer must never delete a shop's data).

; Arabic = LCID 1025. Messages are picked at run time from $LANGUAGE, so no LangString needs the language tables.
!define NOTA_LANG_ARABIC 1025

; In: updated ("1" during an upgrade), silent ("1" for /S), checked ("1" when the box is ticked), confirmed ("1" after the second Yes).
; Out: resultVar = "1" when the data folder must be deleted, else "0".
!macro notaDeleteDataDecide updated silent checked confirmed resultVar
  StrCpy ${resultVar} "0"
  ${If} "${updated}" != "1"
  ${AndIf} "${silent}" != "1"
  ${AndIf} "${checked}" == "1"
  ${AndIf} "${confirmed}" == "1"
    StrCpy ${resultVar} "1"
  ${EndIf}
!macroend

; The only thing that is ever removed: <ProgramData>\Nota, and only through this macro.
!macro notaDeleteDataFolder programData
  ${If} "${programData}" != ""
    RMDir /r "${programData}\Nota"
  ${EndIf}
!macroend
