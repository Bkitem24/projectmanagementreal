// Client Communications - real Gmail/WhatsApp/Slack pages embedded inside
// the main window as child webviews (Tauri's multiwebview support,
// `Window::add_child`, gated behind the "unstable" Cargo feature).
//
// ROOT CAUSE of every blank/unclosable symptom this round (confirmed
// 2026-09-26): these commands used to be synchronous (`pub fn`). Tauri
// runs sync commands on the MAIN thread, and creating a webview from
// there deadlocks on Windows - WebView2's controller creation waits in a
// nested message pump for a callback only the outer event loop can
// deliver (wry#583, tauri#4121; Tauri's own docs say window/webview
// creation in a command must be async). Evidence from the live app: the
// "creating child webview" log line appeared exactly ONCE per launch even
// though the frontend calls this every 500ms - the first call never
// returned, every later call queued behind it, no page ever started
// loading, and the close button stopped working (closing needs the same
// stuck thread). Windows didn't flag the window as "hung" because the
// nested pump keeps processing basic messages. The earlier separate-
// window attempt (whatsapp_web.rs/gmail_web.rs) failed the exact same way
// for the exact same reason - both were sync too - while Slack's original
// login window worked in the Phase A spike because open_slack_login
// happened to be async. Keep every command here `async`.
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

const MAIN_WINDOW_LABEL: &str = "main";

// Labels whose add_child is in flight. The frontend re-sends its rect
// every 500ms, and WebView2 creation can take longer than that - without
// this, a second call would try to create a duplicate with the same label.
pub struct EmbedsInFlight(pub Mutex<HashSet<String>>);

// %TEMP%\bko-embed-log.txt - stdout is invisible for a double-clicked GUI
// app, and this log is what exposed the deadlock above.
fn log_line(line: &str) {
    let path = std::env::temp_dir().join("bko-embed-log.txt");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", line);
    }
}

// x/y/width/height arrive in PHYSICAL pixels (EmbeddedWebview.jsx
// multiplies by devicePixelRatio), relative to the main window's client
// area.
#[tauri::command]
pub async fn embed_webview(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    init_script: Option<String>,
) -> Result<(), String> {
    let position = PhysicalPosition::new(x, y);
    let size = PhysicalSize::new(width.max(1.0), height.max(1.0));

    if let Some(webview) = app.get_webview(&label) {
        webview.set_position(position).map_err(|e| e.to_string())?;
        webview.set_size(size).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let in_flight = app.state::<EmbedsInFlight>();
    if !in_flight.0.lock().unwrap().insert(label.clone()) {
        return Ok(());
    }

    let result = (|| -> Result<(), String> {
        // add_child lives on the raw Window, not WebviewWindow (which
        // doesn't Deref to it) - hence get_window, not get_webview_window.
        let window = app.get_window(MAIN_WINDOW_LABEL).ok_or("main window not found")?;
        let parsed_url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
        let log_label = label.clone();
        log_line(&format!("[embed:{}] creating at physical ({}, {}) size ({}, {}) url={}", label, x, y, width, height, url));
        let mut builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
            .on_page_load(move |_webview, payload| match payload.event() {
                PageLoadEvent::Started => log_line(&format!("[embed:{}] load started: {}", log_label, payload.url())),
                PageLoadEvent::Finished => log_line(&format!("[embed:{}] load finished: {}", log_label, payload.url())),
            });
        if let Some(script) = init_script {
            builder = builder.initialization_script(&script);
        }
        window.add_child(builder, position, size).map_err(|e| e.to_string())?;
        log_line(&format!("[embed:{}] created", label));
        Ok(())
    })();

    in_flight.0.lock().unwrap().remove(&label);
    if let Err(e) = &result {
        log_line(&format!("[embed:{}] failed: {}", label, e));
    }
    result
}

// Moves an embed off-screen rather than destroying it, so its login
// session stays alive for when the person switches back.
#[tauri::command]
pub async fn hide_embedded_webview(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.set_position(PhysicalPosition::new(-10000.0, -10000.0)).map_err(|e| e.to_string())?;
        webview.set_size(PhysicalSize::new(1.0, 1.0)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
