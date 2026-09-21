// TimeLog: randomized-interval screenshots + keyboard/mouse activity,
// while an employee is clocked in. The scheduling (when to take the next
// screenshot, how often to flush activity) lives in JS
// (src/lib/timelog.js) — this module only does the two things that need
// real OS access: grabbing a screen capture, and listening to global
// keyboard/mouse events system-wide (not just inside the app window).
//
// NOT independently verified in this sandbox: the sandbox this app was
// built in has no network access to crates.io, so `cargo build` couldn't
// actually be run here to confirm this compiles and links. The existing
// `.github/workflows/build-windows.yml` DOES have full internet access and
// builds this for real on a Windows runner — treat that build's result
// (and a first real run on Windows) as this module's actual test, and
// expect to iterate on it if the Windows build turns up an API mismatch in
// the `xcap` or `rdev` crates' current versions.
//
// A practical thing worth knowing going in: rdev's global keyboard hook
// reports the literal key that was pressed (via its `name` field where the
// OS provides one, e.g. "a", "5", "!" — falling back to a token like
// "Return" or "Shift" for non-printable keys), for every keystroke typed
// anywhere on the machine while clocked in — there's no per-application or
// per-field awareness, so a password typed into an unrelated program during
// a clocked-in session is captured the same as anything else. That's the
// tradeoff of "full keystroke logging" as specified, not a bug — flagging
// it here since it's easy to forget once this is running quietly.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct ActivityBuffer {
    key_count: u32,
    mouse_distance: f64,
    key_log: String,
    last_mouse: Option<(f64, f64)>,
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static BUFFER: OnceLock<Mutex<ActivityBuffer>> = OnceLock::new();
static LISTENER_STARTED: AtomicBool = AtomicBool::new(false);

fn buffer() -> &'static Mutex<ActivityBuffer> {
    BUFFER.get_or_init(|| Mutex::new(ActivityBuffer::default()))
}

fn ensure_listener_started() {
    if LISTENER_STARTED.swap(true, Ordering::SeqCst) {
        return; // already running from an earlier clock-in this session
    }
    std::thread::spawn(|| {
        // rdev::listen blocks forever pumping a native event loop; it only
        // makes sense to start it once per process, so `timelog_stop` just
        // flips RUNNING to false rather than tearing this down — cheap to
        // leave idle, and avoids re-registering the OS-level hook.
        let callback = |event: rdev::Event| {
            if !RUNNING.load(Ordering::Relaxed) {
                return;
            }
            let mut buf = buffer().lock().unwrap();
            match event.event_type {
                rdev::EventType::KeyPress(key) => {
                    buf.key_count += 1;
                    let token = event.name.unwrap_or_else(|| format!("{:?}", key));
                    if !buf.key_log.is_empty() {
                        buf.key_log.push(' ');
                    }
                    buf.key_log.push_str(&token);
                }
                rdev::EventType::MouseMove { x, y } => {
                    if let Some((lx, ly)) = buf.last_mouse {
                        buf.mouse_distance += ((x - lx).powi(2) + (y - ly).powi(2)).sqrt();
                    }
                    buf.last_mouse = Some((x, y));
                }
                _ => {}
            }
        };
        if let Err(err) = rdev::listen(callback) {
            eprintln!("[blue-kite-ops] activity listener failed to start: {:?}", err);
        }
    });
}

#[tauri::command]
pub fn timelog_start() {
    {
        let mut buf = buffer().lock().unwrap();
        *buf = ActivityBuffer::default();
    }
    ensure_listener_started();
    RUNNING.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn timelog_stop() {
    RUNNING.store(false, Ordering::SeqCst);
}

#[derive(Serialize)]
pub struct ActivityReport {
    #[serde(rename = "keyCount")]
    key_count: u32,
    #[serde(rename = "mouseDistance")]
    mouse_distance: i64,
    #[serde(rename = "keyLog")]
    key_log: String,
}

#[tauri::command]
pub fn timelog_drain_activity() -> ActivityReport {
    let mut buf = buffer().lock().unwrap();
    let report = ActivityReport {
        key_count: buf.key_count,
        mouse_distance: buf.mouse_distance.round() as i64,
        key_log: buf.key_log.clone(),
    };
    buf.key_count = 0;
    buf.mouse_distance = 0.0;
    buf.key_log.clear();
    report
}

// Captures the primary monitor, downsizes and JPEG-compresses it, and hands
// the bytes to JS (which uploads them as-is to R2 — see
// src/lib/timelog.js). Doing the compression here, not in JS, means the
// full-resolution raw bitmap never has to cross the Tauri IPC bridge.
#[tauri::command]
pub fn timelog_capture_screenshot() -> Result<Vec<u8>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| xcap::Monitor::all().ok().and_then(|mut ms| ms.pop()))
        .ok_or_else(|| "No monitor found to capture".to_string())?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;

    // Downscale to a max width of 1600px before encoding — plenty readable
    // for reviewing what someone was working on, at a fraction of the
    // storage/bandwidth of a full 4K/5K capture.
    let dynamic = image::DynamicImage::ImageRgba8(image);
    let (w, h) = (dynamic.width(), dynamic.height());
    let resized = if w > 1600 {
        let new_h = (h as f64 * (1600.0 / w as f64)).round() as u32;
        dynamic.resize(1600, new_h.max(1), image::imageops::FilterType::Triangle)
    } else {
        dynamic
    };

    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut bytes);
    resized
        .write_to(&mut cursor, image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}
