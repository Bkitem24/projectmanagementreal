// Client Communications - embedded real web pages (2026-09-26 follow-up).
// Replaces this round's earlier approach (a separate top-level window per
// channel, src-tauri/src/whatsapp_web.rs and gmail_web.rs, both removed) -
// live testing found those windows rendered fully blank and wouldn't
// respond to being closed. Root cause unconfirmed (network reachability to
// both mail.google.com and web.whatsapp.com checked fine from this same
// machine, so it wasn't a connectivity block) - rather than keep guessing
// at a second architecture we were about to replace anyway, this moves
// straight to what was actually asked for: the real page embedded INSIDE
// the main window's own layout, not a separate window at all.
//
// One generic pair of commands (not one per channel) - the frontend
// measures where it wants the embed to sit (a plain empty <div> in
// CommsPage.jsx/MessagingPage.jsx) and tells Rust the exact rect; this
// creates or repositions a labeled CHILD webview attached to the main
// window at that rect (Tauri 2's multiwebview support, `Window::add_child`
// - the main window here is a WebviewWindow, which derefs to Window).
// Distinct labels per channel (not one shared/reused webview) so each
// channel's own login session survives switching between them.
//
// on_page_load is wired up for real diagnostics this time - the previous
// blank-window symptom had NO error signal anywhere, only a truly blank
// captured screenshot, which made it impossible to tell "never started
// loading" from "loaded and then something failed" from "a screenshot
// tooling artifact" apart. This prints to the app's own stdout (visible via
// `npx tauri dev`'s console, or Windows' `DebugView` for gaining console
// output from a shipped .exe) whenever the embed starts or finishes
// loading, so a real failure now leaves a trace instead of silence.
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use tauri::webview::PageLoadEvent;

const MAIN_WINDOW_LABEL: &str = "main";

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
    let position = LogicalPosition::new(x, y);
    let size = LogicalSize::new(width.max(1.0), height.max(1.0));

    if let Some(webview) = app.get_webview(&label) {
        webview.set_position(position).map_err(|e| e.to_string())?;
        webview.set_size(size).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // add_child is defined on the raw Window, not WebviewWindow (which
    // wraps a Window + its own default Webview but doesn't Deref to it) -
    // get_window (not get_webview_window) is the one that actually exposes
    // it, confirmed against docs.rs for this exact pinned version after
    // the previous build's error named the wrong type.
    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or("main window not found")?;
    let parsed_url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let log_label = label.clone();
    let mut builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
        .on_page_load(move |_webview, payload| {
            match payload.event() {
                PageLoadEvent::Started => println!("[embed:{}] page load started: {}", log_label, payload.url()),
                PageLoadEvent::Finished => println!("[embed:{}] page load finished: {}", log_label, payload.url()),
            }
        });
    if let Some(script) = init_script {
        builder = builder.initialization_script(&script);
    }
    window
        .add_child(builder, position, size)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Moves an embed off-screen and shrinks it to near-zero rather than
// destroying it - keeps its login session/localStorage alive (it's still
// the same webview, just not visible) for when the person switches back.
#[tauri::command]
pub fn hide_embedded_webview(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.set_position(LogicalPosition::new(-10000.0, -10000.0)).map_err(|e| e.to_string())?;
        webview.set_size(LogicalSize::new(1.0, 1.0)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
