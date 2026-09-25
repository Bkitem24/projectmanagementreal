// Tauri here is a native window + installer around the built frontend in
// ../dist, which talks straight to Supabase over HTTPS - plus a handful of
// native-only commands (mod timelog) for things the web view can't do
// itself: capturing the screen and listening to keyboard/mouse activity
// system-wide while an employee is clocked in via TimeLog.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mp4fix;
mod timelog;

// Launch-on-Windows-startup (Phase 2.5 batch A / A-fix, 2026-09-26/27):
// history kept here since it explains why autostart setup does NOT live in
// this file (or any other running-app code) any more.
//
// Attempt 1: tauri-plugin-autostart (a plain registry Run-key entry) -
// confirmed broken by Humayun: "Doesn't work even though in task manager it
// is selected as enabled for launch on startup." Root cause: this app's own
// windows-app-manifest.xml requests requireAdministrator, so it needs UAC
// elevation on EVERY launch, and explorer.exe (what processes the Run key
// at logon) can never silently elevate a child process on someone's behalf.
//
// Attempt 2: a Windows Scheduled Task (ONLOGON trigger, /RL HIGHEST) - the
// standard fix for autostarting something that needs elevation - created by
// this already-elevated process calling schtasks.exe directly from its own
// .setup() hook on every launch. This DID work, but got the installed app
// (blue-kite-ops.exe, its Start Menu shortcut, and the scheduled task
// itself) deleted by Windows Defender: "Behavior:Win32/Execution.A!ml" -
// an ML heuristic for a well-known malware persistence signature (an
// already-elevated process silently re-creating a HIGHEST-privilege
// autostart entry pointing at itself, every single time it runs), which
// this combined with the global keyboard/mouse hook + screen capture
// (src/timelog.rs) this app also legitimately needs for TimeLog.
//
// Fix (this version): moved entirely OUT of the running app and into the
// NSIS INSTALLER itself - see src-tauri/installer-hooks.nsh
// (NSIS_HOOK_POSTINSTALL/NSIS_HOOK_PREUNINSTALL), wired up via
// tauri.conf.json's bundle.windows.nsis.installerHooks. A one-time write
// during install/update/uninstall is normal, expected installer behavior
// (installers create Start Menu shortcuts, registry entries, scheduled
// tasks etc. constantly) - it no longer carries the "running app
// self-modifies system persistence on every launch" signature that got
// this flagged. This app's running code now does nothing autostart-related
// at all.

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Added 2026-09-30 for Meetings recording's "Open folder" button
        // (src/lib/recorder.js's revealInFolder) - the official Tauri v2
        // way to open/reveal a file in the OS's own file explorer.
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            timelog::timelog_start,
            timelog::timelog_stop,
            timelog::timelog_drain_activity,
            timelog::timelog_capture_screenshot,
            timelog::timelog_listener_error,
            timelog::timelog_seconds_idle,
            // Round 39: Meetings recordings -> regular MP4 (src/mp4fix.rs)
            mp4fix::mp4_defragment,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Blue Kite Ops");
}
