// Client Communications - WhatsApp, unofficial route (2026-09-26). Humayun
// explicitly chose this over the official Cloud API (worker-comms-whatsapp/)
// because that path was blocked on Meta's own business-number-registration
// process failing - this needs no Meta Business setup at all.
//
// Unlike Slack (src/slack.rs), which extracts a session token/cookie and
// then talks to Slack's real REST API from Rust - our own CommsPage.jsx
// renders the actual UI - this shows the REAL web.whatsapp.com page itself
// in a dedicated window, exactly as Humayun asked for. There is no public
// API to call instead: WhatsApp's real protocol is an encrypted, proprietary
// multi-device WebSocket protocol (what a library like Baileys
// reverse-engineers); scraping/filtering the actual logged-in web page's own
// DOM is the lower-risk, lower-maintenance option for what was actually
// asked (display real chats, filtered) versus reimplementing that protocol.
//
// Real, known limitation, flagged up front rather than discovered later:
// WhatsApp Web's DOM (class names, structure) changes with their own
// updates, sometimes without notice - the contact filter below is written
// defensively (falls back to showing every chat, never to hiding
// everything, if its selectors stop matching) but may need a selector
// update after a WhatsApp Web release. This is a real maintenance cost that
// the official Cloud API route wouldn't have had - accepted knowingly here
// in exchange for not needing Meta Business approval at all.
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "whatsapp-web";

// `allowed` is a list of contact identifiers - display name and/or phone
// number, however commsContacts already stores them - the chat list keeps
// a chat only if a row's own visible text contains one of these as a
// substring (case-insensitive). Injected as a JSON literal directly into
// the init script rather than fetched over IPC afterward, so filtering is
// already active on the very first paint, before Humayun can see anything
// unfiltered flash by.
fn build_script(allowed: &[String]) -> String {
    let allowed_json = serde_json::to_string(allowed).unwrap_or_else(|_| "[]".to_string());
    format!(
        r#"
(function () {{
  var ALLOWED = {allowed_json}.map(function (s) {{ return String(s).toLowerCase(); }}).filter(Boolean);

  // "Doesn't look like a browser page" already comes from this being a
  // plain chromeless Tauri window (no address bar, no tabs - same as
  // Slack's login window) - nothing further to inject here for that part.

  if (!ALLOWED.length) return; // no allow-list configured - show every chat, unfiltered.

  var ROW_SELECTOR = '[data-testid="cell-frame-container"]';

  function applyFilter() {{
    var rows = document.querySelectorAll(ROW_SELECTOR);
    if (!rows.length) return false; // selector didn't match anything - WhatsApp's markup may have changed; leave everything as-is rather than hiding real chats.
    rows.forEach(function (row) {{
      var text = (row.textContent || '').toLowerCase();
      var match = ALLOWED.some(function (needle) {{ return text.indexOf(needle) !== -1; }});
      var item = row.closest('[role="listitem"]') || row;
      item.style.display = match ? '' : 'none';
    }});
    return true;
  }}

  // WhatsApp Web is a client-rendered SPA - the chat list doesn't exist at
  // script-injection time, and re-renders on every new/updated chat, so this
  // both polls until the list first appears AND keeps re-applying via a
  // MutationObserver for anything that shows up afterward.
  var tries = 0;
  var poll = setInterval(function () {{
    tries++;
    if (applyFilter() || tries > 40) clearInterval(poll); // ~20s of trying, then give up quietly (fail open).
  }}, 500);

  var pane = document.getElementById('pane-side') || document.body;
  new MutationObserver(function () {{ applyFilter(); }}).observe(pane, {{ childList: true, subtree: true }});
}})();
"#,
        allowed_json = allowed_json
    )
}

#[tauri::command]
pub fn open_whatsapp_web(app: AppHandle, allowed_contacts: Vec<String>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        WebviewUrl::External(
            "https://web.whatsapp.com/"
                .parse()
                .map_err(|e: url::ParseError| e.to_string())?,
        ),
    )
    .title("WhatsApp - Blue Kite Ops")
    .inner_size(1100.0, 800.0)
    .initialization_script(&build_script(&allowed_contacts))
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
pub struct WhatsAppWebStatus {
    open: bool,
}

#[tauri::command]
pub fn whatsapp_web_status(app: AppHandle) -> WhatsAppWebStatus {
    WhatsAppWebStatus { open: app.get_webview_window(WINDOW_LABEL).is_some() }
}
