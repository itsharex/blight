Unicode true

####
## Please note: Template replacements don't work in this file. They are provided with default defines like
## mentioned underneath.
## If the keyword is not defined, "wails_tools.nsh" will populate them with the values from ProjectInfo.
## If they are defined here, "wails_tools.nsh" will not touch them. This allows to use this project.nsi manually
## from outside of Wails for debugging and development of the installer.
##
## For development first make a wails nsis build to populate the "wails_tools.nsh":
## > wails build --target windows/amd64 --nsis
## Then you can call makensis on this file with specifying the path to your binary:
## For a AMD64 only installer:
## > makensis -DARG_WAILS_AMD64_BINARY=..\..\bin\blight.exe
####
## The following information is taken from the ProjectInfo file, but they can be overwritten here.
####
## !define INFO_PROJECTNAME    "MyProject" # Default "{{.Name}}"
## !define INFO_COMPANYNAME    "MyCompany" # Default "{{.Info.CompanyName}}"
## !define INFO_PRODUCTNAME    "MyProduct" # Default "{{.Info.ProductName}}"
## !define INFO_PRODUCTVERSION "1.0.0"     # Default "{{.Info.ProductVersion}}"
## !define INFO_COPYRIGHT      "Copyright" # Default "{{.Info.Copyright}}"
###
## !define PRODUCT_EXECUTABLE  "Application.exe"      # Default "${INFO_PROJECTNAME}.exe"
## !define UNINST_KEY_NAME     "UninstKeyInRegistry"  # Default "${INFO_COMPANYNAME}${INFO_PRODUCTNAME}"
####
## !define REQUEST_EXECUTION_LEVEL "admin"            # Default "admin"  see also https://nsis.sourceforge.io/Docs/Chapter4.html
####
## Include the wails tools
####
!include "wails_tools.nsh"

# The version information for this two must consist of 4 parts
VIProductVersion "${INFO_PRODUCTVERSION}.0"
VIFileVersion    "${INFO_PRODUCTVERSION}.0"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Installer"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

# Enable HiDPI support. https://nsis.sourceforge.io/Reference/ManifestDPIAware
ManifestDPIAware true

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_ABORTWARNING

# Run blight after install
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch blight"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

## Signing hooks (uncomment and configure when a code signing cert is available)
#!uninstfinalize 'signtool --file "%1"'
#!finalize 'signtool --file "%1"'

Name "${INFO_PRODUCTNAME}"
OutFile "..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe"
InstallDir "$LOCALAPPDATA\${INFO_PRODUCTNAME}"  ; Install to %LOCALAPPDATA%\blight — no admin required
InstallDirRegKey HKCU "Software\${INFO_PRODUCTNAME}" "InstallDir"
ShowInstDetails show
RequestExecutionLevel user  ; No UAC prompt needed — installs to user directory

Function .onInit
    !insertmacro wails.checkArchitecture

    ; Kill any running instance before updating
    ExecWait 'taskkill /f /im "${PRODUCT_EXECUTABLE}"' $0
FunctionEnd

Section "Install"
    !insertmacro wails.setShellContext

    !insertmacro wails.webview2runtime

    SetOutPath $INSTDIR

    !insertmacro wails.files

    ; Store install dir in registry
    WriteRegStr HKCU "Software\${INFO_PRODUCTNAME}" "InstallDir" $INSTDIR

    ; Start Menu shortcut
    CreateDirectory "$SMPROGRAMS\${INFO_PRODUCTNAME}"
    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}\Uninstall ${INFO_PRODUCTNAME}.lnk" "$INSTDIR\uninstall.exe"

    ; Auto-start with Windows (launcher apps should always be running)
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${INFO_PRODUCTNAME}" "$INSTDIR\${PRODUCT_EXECUTABLE}"

    !insertmacro wails.associateFiles
    !insertmacro wails.associateCustomProtocols

    !insertmacro wails.writeUninstaller

    ; Clean up old direct-download binaries from the user's Downloads folder
    Var /GLOBAL CleanupHandle
    Var /GLOBAL CleanupFile
    FindFirst $CleanupHandle $CleanupFile "$PROFILE\Downloads\blight-windows-amd64*.exe"
    ${While} $CleanupFile != ""
        Delete "$PROFILE\Downloads\$CleanupFile"
        FindNext $CleanupHandle $CleanupFile
    ${EndWhile}
    FindClose $CleanupHandle
SectionEnd

Section "Uninstall"
    !insertmacro wails.setShellContext

    ; Kill running instance
    ExecWait 'taskkill /f /im "${PRODUCT_EXECUTABLE}"' $0

    ; Remove auto-start entry
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${INFO_PRODUCTNAME}"

    ; Remove install dir registry key
    DeleteRegKey HKCU "Software\${INFO_PRODUCTNAME}"

    ; Remove WebView2 user data
    RMDir /r "$LOCALAPPDATA\${INFO_PRODUCTNAME}\EBWebView"

    ; Remove files
    RMDir /r $INSTDIR

    ; Remove Start Menu shortcuts
    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}\${INFO_PRODUCTNAME}.lnk"
    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}\Uninstall ${INFO_PRODUCTNAME}.lnk"
    RMDir "$SMPROGRAMS\${INFO_PRODUCTNAME}"

    !insertmacro wails.unassociateFiles
    !insertmacro wails.unassociateCustomProtocols

    !insertmacro wails.deleteUninstaller
SectionEnd
