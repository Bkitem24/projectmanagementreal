; Custom NSIS installer hooks, wired up via tauri.conf.json's
; bundle.windows.nsis.installerHooks. Tauri's own NSIS template calls these
; macros (if defined) at the matching point in install/uninstall - see
; https://v2.tauri.app/distribute/windows-installer/ ("NSIS installer hooks").
;
; Currently used for exactly one thing: launch-on-Windows-startup. See
; src/main.rs's header comment for the full history - short version: this
; used to be a schtasks.exe Scheduled Task created by the RUNNING app on
; every launch, which worked, but Windows Defender deleted the installed
; app over it ("Behavior:Win32/Execution.A!ml" - an already-elevated
; process silently re-creating a HIGHEST-privilege autostart entry pointing
; at itself is a well-known malware persistence pattern to ML heuristics).
; Creating the exact same scheduled task ONCE, from the INSTALLER, at
; install/update time - not from the shipped app, not on every launch - is
; normal, expected installer behavior and doesn't carry that signature.
;
; /RL HIGHEST (run the task elevated, no UAC prompt at logon - the standard
; way to autostart something that itself needs admin rights, since this
; app's windows-app-manifest.xml requests requireAdministrator on every
; launch) needs to be set from an ELEVATED context, but this installer runs
; in "currentUser" (non-elevated) mode by choice (tauri.conf.json). So the
; schtasks.exe calls below run via the "runas" shell verb specifically -
; this pops one UAC consent prompt during install/uninstall (expected and
; consistent with the app itself needing admin every launch), then the
; scheduled task creation/removal actually happens elevated, same as it did
; when the app created it itself.
;
; The exe name below is hardcoded to match Cargo.toml's [[bin]] name
; ("blue-kite-ops") rather than relying on a NSIS template define, since
; that's the one thing in this file that would silently break the whole
; hook if guessed wrong and there's no local way to compile-test this NSIS
; script (no local Rust/NSIS toolchain) - if that bin name is ever renamed,
; update the two "blue-kite-ops.exe" references below to match.

!macro NSIS_HOOK_POSTINSTALL
  ExecShellWait "runas" "schtasks.exe" '/Create /F /SC ONLOGON /RL HIGHEST /TN "BlueKiteOpsAutostart" /TR "\"$INSTDIR\blue-kite-ops.exe\""' SW_HIDE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecShellWait "runas" "schtasks.exe" '/Delete /TN "BlueKiteOpsAutostart" /F' SW_HIDE
!macroend
