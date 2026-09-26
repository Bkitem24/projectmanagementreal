// Client Communications - Gmail, real inbox (2026-09-26 follow-up). The
// original Gmail Comms (worker-comms-gmail/, IMAP poll into commsMessages +
// CommsPage.jsx's own three-pane reader) was a smaller, custom rebuild of
// an inbox, not the real thing - Humayun asked for the actual, full
// gmail.com inbox instead, same as the WhatsApp/Slack windows. Unlike
// WhatsApp (src/whatsapp_web.rs), there's no contact filter here - a real
// inbox is what was asked for, not a filtered slice of it. Unlike Slack
// (src/slack.rs), nothing is extracted from this window either - it's
// purely a real, live, logged-in Gmail session, displayed. If more than
// one Gmail account is connected, Gmail's own account switcher (inside the
// window itself) is how Humayun moves between them - there's no reliable
// way to map our internal account id to Google's own /u/N index.
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "gmail-web";

#[tauri::command]
pub fn open_gmail_web(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        WebviewUrl::External(
            "https://mail.google.com/"
                .parse()
                .map_err(|e: url::ParseError| e.to_string())?,
        ),
    )
    .title("Gmail - Blue Kite Ops")
    .inner_size(1100.0, 800.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
