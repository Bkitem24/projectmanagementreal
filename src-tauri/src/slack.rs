// Client Communications - Slack (Phase A). Opens the real Slack web app,
// Humayun (or a granted manager) logs in themselves - never entering
// credentials from Rust/JS here - and this captures the session Slack's own
// web client already holds: a per-workspace xoxc- token (from its own
// localStorage) plus the shared `d` session cookie (via Tauri's native
// cookie API, since xoxc- tokens need that cookie alongside them for real
// API calls). Both are stored in Windows Credential Manager, per the
// project's decision: session lives ONLY on this machine, never the
// server (see project_overhaul-roadmap.md memory).
//
// Real bug found and FIXED here (Spike 5, 2026-09-25): calling
// `w.cookies_for_url()` from a Tauri command handler hung indefinitely.
// Root cause, confirmed by reading wry's own Windows implementation
// (wry-0.55.1/src/webview2/mod.rs's cookies_inner): it uses WebView2's
// async GetCookies() COM API, waited on via `webview2_com::wait_with_pump`
// - which pumps the CALLING thread's message queue while it waits. Tauri
// v2 dispatches command handlers onto a background thread pool by
// default, not the main UI thread WebView2 actually delivers its
// completion callback to - so the calling thread pumps a queue nothing is
// ever posted to, and waits forever. Fix: run the actual `cookies_for_url`
// call via `AppHandle::run_on_main_thread`, which really does run it on
// the thread WebView2 expects, and hand the result back through a
// `tokio::sync::oneshot` channel so the (async) command can await it
// normally. UNVERIFIED IN THIS SESSION - the hypothesis is sound and
// matches the wry source precisely, but confirming it needs a real Slack
// login again, which needs Humayun live - flagged clearly in the punch
// list until he's done that once.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const KEYRING_SERVICE: &str = "BlueKiteOps.Slack";
const LOGIN_WINDOW_LABEL: &str = "slack-login";

const CAPTURE_SCRIPT: &str = r#"
(function () {
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    try {
      var raw = localStorage.getItem('localConfig_v2');
      if (raw) {
        var cfg = JSON.parse(raw);
        var teams = cfg.teams || {};
        var workspaces = Object.keys(teams).map(function (id) {
          var t = teams[id];
          return { teamId: id, name: t.name || id, token: t.token || null };
        }).filter(function (w) { return w.token; });
        if (workspaces.length) {
          clearInterval(timer);
          window.__TAURI_INTERNALS__.invoke('report_slack_tokens', { workspaces: workspaces });
        }
      }
    } catch (e) { /* localStorage not ready yet - keep polling */ }
    // No fixed give-up timeout this time (Spike 5's 5-minute cutoff fired
    // before Humayun actually finished logging in, a real bug) - polls for
    // as long as the login window itself stays open.
  }, 500);
})();
"#;

#[derive(Deserialize)]
pub struct SlackWorkspaceToken {
    #[serde(rename = "teamId")]
    team_id: String,
    name: String,
    token: String,
}

#[derive(Serialize)]
pub struct SlackWorkspaceSummary {
    team_id: String,
    name: String,
    token_len: usize,
}

#[tauri::command]
pub async fn open_slack_login(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        LOGIN_WINDOW_LABEL,
        WebviewUrl::External("https://app.slack.com/".parse().map_err(|e: url::ParseError| e.to_string())?),
    )
    .title("Sign in to Slack - Blue Kite Ops")
    .inner_size(1100.0, 800.0)
    .initialization_script(CAPTURE_SCRIPT)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn report_slack_tokens(workspaces: Vec<SlackWorkspaceToken>) -> Result<Vec<SlackWorkspaceSummary>, String> {
    let mut out = vec![];
    for w in workspaces {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &format!("token:{}", w.team_id)).map_err(|e| e.to_string())?;
        entry.set_password(&w.token).map_err(|e| e.to_string())?;
        println!("[slack] stored token for workspace {} ({}), len {}", w.team_id, w.name, w.token.len());
        out.push(SlackWorkspaceSummary { team_id: w.team_id, name: w.name, token_len: w.token.len() });
    }
    Ok(out)
}

// THE FIX: run the actual cookie read on the main thread (see module
// comment), await its result via a oneshot channel.
#[tauri::command]
pub async fn capture_slack_cookie(app: AppHandle) -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| -> Result<String, String> {
            let w = app2.get_webview_window(LOGIN_WINDOW_LABEL).ok_or("Slack login window isn't open")?;
            let cookies = w
                .cookies_for_url("https://app.slack.com/".parse().map_err(|e: url::ParseError| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let d = cookies.iter().find(|c| c.name() == "d").ok_or("no 'd' cookie yet - log in first")?;
            let entry = keyring::Entry::new(KEYRING_SERVICE, "cookie:d").map_err(|e| e.to_string())?;
            entry.set_password(d.value()).map_err(|e| e.to_string())?;
            Ok(format!("captured, len {}", d.value().len()))
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_stored_slack_workspaces() -> Result<Vec<String>, String> {
    let path = std::env::temp_dir().join("bko-slack-known-teams.json");
    if !path.exists() { return Ok(vec![]); }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remember_known_team(team_id: String) -> Result<(), String> {
    let path = std::env::temp_dir().join("bko-slack-known-teams.json");
    let mut known: Vec<String> = if path.exists() {
        serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?).unwrap_or_default()
    } else { vec![] };
    if !known.contains(&team_id) { known.push(team_id); }
    std::fs::write(&path, serde_json::to_string(&known).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn get_token(team_id: &str) -> Result<String, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("token:{}", team_id))
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|e| format!("no stored session for {} ({}) - log in again", team_id, e))
}
fn get_cookie() -> Result<String, String> {
    keyring::Entry::new(KEYRING_SERVICE, "cookie:d")
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|e| format!("no stored Slack cookie ({}) - log in again", e))
}

async fn slack_api(method: &str, token: &str, cookie: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("https://slack.com/api/{}", method))
        .header("Authorization", format!("Bearer {}", token))
        .header("Cookie", format!("d={}", cookie))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

// Real conversations + history for a connected workspace - used by the
// Gmail-style poller equivalent for Slack (main.js side calls this
// periodically, same 2-minute cadence as the Gmail Worker's Cron, since
// Slack has no server-side webhook option here - a guest session can only
// poll). Filters to only contacts explicitly tied to a client - the same
// privacy rule as every other channel - matching happens in JS (main.js's
// comms.js), this just returns the raw data.
#[tauri::command]
pub async fn slack_list_conversations(team_id: String) -> Result<serde_json::Value, String> {
    let token = get_token(&team_id)?;
    let cookie = get_cookie()?;
    slack_api("users.conversations", &token, &cookie, serde_json::json!({ "types": "im,mpim", "limit": 100 })).await
}

#[tauri::command]
pub async fn slack_get_history(team_id: String, channel: String, oldest: Option<String>) -> Result<serde_json::Value, String> {
    let token = get_token(&team_id)?;
    let cookie = get_cookie()?;
    let mut body = serde_json::json!({ "channel": channel, "limit": 50 });
    if let Some(o) = oldest { body["oldest"] = serde_json::Value::String(o); }
    slack_api("conversations.history", &token, &cookie, body).await
}

#[tauri::command]
pub async fn slack_send_message(team_id: String, channel: String, text: String) -> Result<serde_json::Value, String> {
    let token = get_token(&team_id)?;
    let cookie = get_cookie()?;
    slack_api("chat.postMessage", &token, &cookie, serde_json::json!({ "channel": channel, "text": text })).await
}

#[tauri::command]
pub async fn slack_auth_test(team_id: String) -> Result<serde_json::Value, String> {
    let token = get_token(&team_id)?;
    let cookie = get_cookie()?;
    slack_api("auth.test", &token, &cookie, serde_json::json!({})).await
}
