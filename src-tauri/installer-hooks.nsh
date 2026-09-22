; Custom NSIS installer hooks, wired up via tauri.conf.json's
; bundle.windows.nsis.installerHooks. Tauri's own NSIS template calls these
; macros (if defined) at the matching point in install/uninstall - see
; https://v2.tauri.app/distribute/windows-installer/ ("NSIS installer hooks").
;
; Currently used for exactly one thing: launch-on-Windows-startup. See
; src/main.rs's header comment for the fuller history. Short version of
; where this file fits in: a Windows Scheduled Task (ONLOGON trigger,
; /RL HIGHEST) is the standard way to autostart an app that itself needs
; admin elevation on every launch (this app's windows-app-manifest.xml
; requests requireAdministrator). Creating that task from the RUNNING app
; on every launch worked, but got the installed app deleted by Windows
; Defender ("Behavior:Win32/Execution.A!ml" - an already-elevated process
; silently re-creating a HIGHEST-privilege autostart entry pointing at
; itself is a well-known malware persistence pattern to ML heuristics).
;
; ROUND 9 attempt: create the task once, from the INSTALLER instead of the
; running app - correct call, but the installer ran in "currentUser"
; (non-elevated) mode, so creating a /RL HIGHEST task needs elevation the
; installer itself didn't have. That version tried to elevate just the
; schtasks.exe call with `ExecShellWait "runas" ...` - confirmed NOT to
; work in practice (autostart silently never got set up, no error, no UAC
; prompt Humayun noticed) - ShellExecute's "runas" verb from inside an NSIS
; hook is a known-fragile pattern (it can fail to trigger the secure-desktop
; consent prompt at all in some install contexts, and NSIS's nsExec/
; ExecShellWait give no reliable way to detect that failure).
;
; ROUND 10 fix (this version): switched tauri.conf.json's installMode to
; "perMachine" instead. A perMachine NSIS installer embeds its own
; requireAdministrator manifest, so Windows shows exactly ONE UAC prompt
; the moment the installer itself launches - before any wizard screen -
; and everything the installer does after that, including this hook, runs
; already elevated. That removes the runas dependency entirely: the
; schtasks.exe calls below are now plain elevated child processes of an
; already-elevated parent, the same reliable shape the original (Defender-
; flagged) runtime version used, just issued once by the installer instead
; of by the app on every launch. One UAC prompt at install/update/uninstall
; time is a normal, expected cost for software that needs admin rights, and
; is consistent with this app already asking for elevation on every launch.
;
; Side effect of perMachine worth knowing: install location moves from
; %LOCALAPPDATA% to Program Files, and Start Menu/uninstall entries move
; from per-user to all-users. Anyone with an existing currentUser-mode
; install should uninstall it first to avoid ending up with two separate
; installs side by side.
;
; The exe name below is hardcoded to match Cargo.toml's [[bin]] name
; ("blue-kite-ops") rather than relying on a NSIS template define, since
; that's the one thing in this file that would silently break the whole
; hook if guessed wrong and there's no local way to compile-test this NSIS
; script (no local Rust/NSIS toolchain) - if that bin name is ever renamed,
; update the two "blue-kite-ops.exe" references below to match. Uses
; nsExec::ExecToLog (not plain ExecWait) so both commands' output lands in
; the installer's own "Show details" log if anything ever needs debugging
; again.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog 'schtasks.exe /Create /F /SC ONLOGON /RL HIGHEST /TN "BlueKiteOpsAutostart" /TR "\"$INSTDIR\blue-kite-ops.exe\""'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'schtasks.exe /Delete /TN "BlueKiteOpsAutostart" /F'
!macroend
