; NSIS hooks for the Windows installer (referenced from tauri.windows.conf.json).
; Keeps install / update / uninstall tidy: no stray process, no leftover login entry.

!macro NSIS_HOOK_PREINSTALL
  ; Updating over a running copy: close it first so its files can be replaced.
  nsExec::Exec 'taskkill /F /IM clickr.exe'
  Sleep 400
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM clickr.exe'
  Sleep 400
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; "Open at login" entry written by the autostart plugin.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Clickr AI"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "clickr"
  ; clickr:// sign-in link (also re-created by the app at launch).
  DeleteRegKey HKCU "Software\Classes\clickr"
!macroend
