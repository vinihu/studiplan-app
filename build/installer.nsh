# Additions to electron-builder's NSIS installer (see `nsis.include` in electron-builder.yml).
#
# electron-builder's installer keeps a copy of itself in
# %LOCALAPPDATA%\studiplan-app-updater\installer.exe for its auto-updater, and its uninstaller
# leaves that copy behind. Studiplan has no auto-update, so the copy is only wasted disk space
# that would outlive the app. It is removed right after installing, and again on uninstall in
# case an older installer left one.
#
# Only that one file is deleted, and the folder only if it is then empty. Nothing here touches
# the user's settings (%APPDATA%\Studiplan) or the library.

!macro removeInstallerCopy
  Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  RMDir "$LOCALAPPDATA\studiplan-app-updater"
!macroend

!macro customInstall
  !insertmacro removeInstallerCopy
!macroend

!macro customUnInstall
  !insertmacro removeInstallerCopy
!macroend
