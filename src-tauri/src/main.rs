// Tauri here is a native window + installer around the built frontend in
// ../dist, which talks straight to Supabase over HTTPS - plus a handful of
// native-only commands (mod timelog) for things the web view can't do
// itself: capturing the screen and listening to keyboard/mouse activity
// system-wide while an employee is clocked in via TimeLog.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod timelog;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
round 6 fixes
