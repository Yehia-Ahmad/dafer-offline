; Test harness for installer-offline/notaData.nsh: not shipped. It is compiled and run by electron-offline/test/stage25-installer.test.js.
; Defines passed by the test (makensis /D...): T_UPDATED T_SILENT T_CHECKED T_CONFIRMED T_ROOT (a fake ProgramData folder) T_OUT (a result file).
Unicode true
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "notaData.nsh"

OutFile "${T_EXE}"
RequestExecutionLevel user
SilentInstall silent
ShowInstDetails nevershow

Var decision

Section
  !insertmacro notaDeleteDataDecide "${T_UPDATED}" "${T_SILENT}" "${T_CHECKED}" "${T_CONFIRMED}" $decision
  ${If} $decision == "1"
    !insertmacro notaDeleteDataFolder "${T_ROOT}"
  ${EndIf}
  FileOpen $0 "${T_OUT}" w
  FileWrite $0 "decision=$decision"
  FileClose $0
SectionEnd
