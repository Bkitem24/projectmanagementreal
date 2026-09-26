// Client Communications - embedded real web pages (2026-09-26 follow-up).
// Replaces this round's earlier approach (a separate top-level window per
// channel, src-tauri/src/whatsapp_web.rs and gmail_web.rs, both removed) -
// live testing found those windows rendered fully blank and wouldn't
// respond to being closed. Embedding hit the exact same symptom (blank,
// and now the MAIN window itself wouldn't close either) - this round's
// fix targets two concrete, confirmed-plausible causes rather than
// guessing again:
//
// 1. LOGICAL vs PHYSICAL pixels on an unusual multi-monitor setup. This
//    machine's main window sits at a genuinely odd virtual-desktop
//    position (observed live: rect -8,-8 to 3448,1400, spanning two
//    monitors) - exactly the kind of layout where a Logical-to-Physical
//    conversion bug in an "unstable"/experimental API (Tauri's own
//    multiwebview support) could place a child webview off-screen or at
//    zero size while it's still genuinely alive and even loading content
//    correctly. Fixed by computing PHYSICAL pixels ourselves in JS
//    (devicePixelRatio) and using PhysicalPosition/PhysicalSize here,
//    removing any ambiguity about which scale factor Tauri applies
//    internally for this code path.
// 2. The app-close hang. Tauri's default shutdown may not know to tear
//    down "unstable" child webviews on its own - if the underlying
//    WebView2 child process for a genuinely stuck/loading embed never
//    reports itself as closable, the whole app could hang waiting on it.
//    Fixed by tracking every embedded label in app state and explicitly
//    closing each one when the main window's close is requested (wired
//    up in main.rs's .setup()), before the app is allowed to exit.
//
// Diagnostics: on_page_load now writes to a real file (not stdout, which
// is invisible for a double-clicked GUI app with no attached console) -
// %TEMP%\bko-embed-log.txt - so a real failure leaves a trace this round,
// where the previous round's blank screenshot gave no signal at all.
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

const MAIN_WINDOW_LABEL: &str = "main";

pub struct EmbeddedLabels(pub Mutex<Vec<String>>);

fn log_line(line: &str) {
    let path = std::env::temp_dir().join("bko-embed-log.txt");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", line);
    }
}

#[tauri::command]
pub fn embed_webview(
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

    // add_child is defined on the raw Window, not WebviewWindow (which
    // wraps a Window + its own default Webview but doesn't Deref to it) -
    // get_window (not get_webview_window) is the one that actually exposes
    // it.
    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or("main window not found")?;
    let parsed_url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let log_label = label.clone();
    log_line(&format!("[embed:{}] creating child webview at physical ({}, {}) size ({}, {}) url={}", label, x, y, width, height, url));
    let mut builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
        .on_page_load(move |_webview, payload| {
            match payload.event() {
                PageLoadEvent::Started => log_line(&format!("[embed:{}] page load started: {}", log_label, payload.url())),
                PageLoadEvent::Finished => log_line(&format!("[embed:{}] page load finished: {}", log_label, payload.url())),
            }
        });
    if let Some(script) = init_script {
        builder = builder.initialization_script(&script);
    }
    window
        .add_child(builder, position, size)
        .map_err(|e| { log_line(&format!("[embed:{}] add_child failed: {}", label, e)); e.to_string() })?;

    if let Some(state) = app.try_state::<EmbeddedLabels>() {
        state.0.lock().unwrap().push(label);
    }
    Ok(())
}

// Moves an embed off-screen and shrinks it to near-zero rather than
// destroying it - keeps its login session/localStorage alive (it's still
// the same webview, just not visible) for when the person switches back.
#[tauri::command]
pub fn hide_embedded_webview(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.set_position(PhysicalPosition::new(-10000.0, -10000.0)).map_err(|e| e.to_string())?;
        webview.set_size(PhysicalSize::new(1.0, 1.0)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Called from main.rs's main-window CloseRequested handler - explicitly
// closes every embedded child webview before the app is allowed to exit,
// in case a genuinely stuck one would otherwise hang the whole app's
// shutdown.
pub fn close_all_embedded(app: &AppHandle) {
    if let Some(state) = app.try_state::<EmbeddedLabels>() {
        let labels = state.0.lock().unwrap().clone();
        for label in labels {
            if let Some(webview) = app.get_webview(&label) {
                log_line(&format!("[embed:{}] closing on app shutdown", label));
                let _ = webview.close();
            }
        }
    }
}
