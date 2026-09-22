// Tauri here is a native window + installer around the built frontend in
// ../dist, which talks straight to Supabase over HTTPS - plus a handful of
// native-only commands (mod timelog) for things the web view can't do
// itself: capturing the screen and listening to keyboard/mouse activity
// system-wide while an employee is clocked in via TimeLog.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod timelog;

// Phase 2.5 batch A follow-up (2026-09-27): launch on Windows startup,
// enabled by default. The FIRST attempt at this (tauri-plugin-autostart, a
// plain registry Run-key entry, shipped in batch A) was confirmed broken by
// Humayun: "Doesn't work even though in task manager it is selected as
// enabled for launch on startup." That exact symptom is the well-known
// signature of one specific conflict - this app's own
// windows-app-manifest.xml requests requireAdministrator, so it needs UAC
// elevation on EVERY launch. explorer.exe is what processes the Run
// registry key at logon, and explorer.exe can never silently elevate a
// child process on someone's behalf - there's not even an interactive
// desktop yet at that point for a UAC prompt to appear on. So Windows just
// quietly refuses to start it: the registry entry is there (which is
// exactly what Task Manager's Startup tab was showing as "Enabled"), but
// the process itself never actually runs.
//
// The standard fix for autostarting an app that requires elevation is a
// Windows SCHEDULED TASK with an ONLOGON trigger and "Run with highest
// privileges" (/RL HIGHEST) instead of a registry key - that combination
// launches an elevated process at logon with no interactive UAC prompt at
// all, because the task itself was already authorized (by an
// administrator - this process, since it's already elevated) at CREATE
// time, not at launch time. So this replaces tauri-plugin-autostart
// entirely: no more registry key, just a direct schtasks.exe call from
// this already-elevated process's own .setup() hook. /F makes it
// idempotent (recreating an existing task just overwrites it, safe to run
// on every launch) and also keeps the target .exe path current if a future
// update ever moves the install to a new folder.
#[cfg(target_os = "windows")]
fn register_autostart_task() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return, // best-effort - a launch should never fail over this
    };
    // schtasks parses /TR's value as its own little command line, so the
    // path needs its OWN pair of quotes inside the one argument Command
    // passes it as - not just Command's usual automatic quoting for the
    // space in e.g. "Blue Kite Ops.exe" itself.
    let tr_value = format!("\"{}\"", exe_path.display());
    let _ = Command::new("schtasks")
        .args([
            "/Create", "/F",
            "/SC", "ONLOGON",
            "/RL", "HIGHEST",
            "/TN", "BlueKiteOpsAutostart",
            "/TR", tr_value.as_str(),
        ])
        .creation_flags(CREATE_NO_WINDOW) // no flashing console window on every launch
        .output(); // best-effort, same as the old plugin's enable() call - never blocks launch on failure
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            register_autostart_task();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            timelog::timelog_start,
            timelog::timelog_stop,
            timelog::timelog_drain_activity,
            timelog::timelog_capture_screenshot,
            timelog::timelog_listener_error,
            timelog::timelog_seconds_idle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Blue Kite Ops");
}
