// Tauri here is a native window + installer around the built frontend in
// ../dist, which talks straight to Supabase over HTTPS - plus a handful of
// native-only commands (mod timelog) for things the web view can't do
// itself: capturing the screen and listening to keyboard/mouse activity
// system-wide while an employee is clocked in via TimeLog.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mp4fix;
// Client Communications (Phase A) - see src/slack.rs's own module comment
// for the cookie-capture bug this fixes. Its own commands stay registered
// (harmless, unused) - Slack now goes through embedded_webview.rs like
// Gmail/WhatsApp, see that module's comment for why.
mod slack;
mod timelog;
// Client Communications - real pages embedded inside the main window
// (Phase B follow-up, 2026-09-26) - see src/embedded_webview.rs's own
// module comment. Replaces this round's earlier separate-window attempt.
mod embedded_webview;

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
        .manage(embedded_webview::EmbeddedLabels(std::sync::Mutex::new(Vec::new())))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Added 2026-09-30 for Meetings recording's "Open folder" button
        // (src/lib/recorder.js's revealInFolder) - the official Tauri v2
        // way to open/reveal a file in the OS's own file explorer.
        .plugin(tauri_plugin_opener::init())
        // Phase B follow-up (2026-09-26): explicitly closes every embedded
        // child webview (src/embedded_webview.rs) before the app is
        // allowed to exit - a real "app won't close" hang was observed
        // live with an embedded webview open, and Tauri's default shutdown
        // may not know to tear down an "unstable"-feature child webview on
        // its own.
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        embedded_webview::close_all_embedded(&handle);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            timelog::timelog_start,
            timelog::timelog_stop,
            timelog::timelog_drain_activity,
            timelog::timelog_capture_screenshot,
            timelog::timelog_listener_error,
            timelog::timelog_seconds_idle,
            // Round 39: Meetings recordings -> regular MP4 (src/mp4fix.rs)
            mp4fix::mp4_defragment,
            // Phase A / Phase A Round 2: Slack Client Comms (src/slack.rs)
            slack::open_slack_login,
            slack::report_slack_tokens,
            slack::capture_slack_cookie,
            slack::list_stored_slack_workspaces,
            slack::remember_known_team,
            slack::slack_list_conversations,
            slack::slack_get_history,
            slack::slack_send_message,
            slack::slack_auth_test,
            // Phase B follow-up: Gmail/WhatsApp/Slack embedded in the main
            // window (src/embedded_webview.rs)
            embedded_webview::embed_webview,
            embedded_webview::hide_embedded_webview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Blue Kite Ops");
}
