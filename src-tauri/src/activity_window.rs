//! The Activity Log window: a second webview that shows what the app has been doing.
//!
//! It loads the same frontend bundle as the main window, and `src/main.tsx` renders the log view
//! when the window label is [`WINDOW_LABEL`]. It opens from the native Help menu (see
//! `app_menu`) and from the `open_activity_log_window` command, and never needs the network.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Must match the label `src/main.tsx` routes on and the `windows` entry of
/// `capabilities/activity-log.json`.
pub const WINDOW_LABEL: &str = "activity-log";

const MAIN_WINDOW_LABEL: &str = "main";
/// Shown until the frontend replaces it with the localized title.
const WINDOW_TITLE: &str = "Activity Log";
const WINDOW_SIZE: (f64, f64) = (1040.0, 680.0);
const WINDOW_MIN_SIZE: (f64, f64) = (640.0, 360.0);

static OPEN_LOCK: Mutex<()> = Mutex::new(());
/// Kept in step by `on_window_event`, so the menu callback can read it without asking the
/// window, which that callback must not do.
static FOCUSED: AtomicBool = AtomicBool::new(false);

/// Whether the log window is the active window. On macOS the menu bar is shared by every
/// window, so a Photos shortcut pressed here would otherwise act on the main window's selection.
pub fn is_focused() -> bool {
    FOCUSED.load(Ordering::Acquire)
}

/// Opens the log window, or brings it to the front when it is already open.
#[tauri::command]
pub async fn open_activity_log_window(app: AppHandle) -> Result<(), String> {
    open(&app)
}

/// Opens the log window without blocking the caller. Creating a window from a native menu
/// callback can deadlock on Windows, so the work moves to the async runtime.
pub fn open_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Failures are already logged by `open`, and a menu click has nobody to report them to.
        let _ = open(&app);
    });
}

fn open(app: &AppHandle) -> Result<(), String> {
    // A second click while the first window is still being created must not try to create
    // another one with the same label.
    let _serialized = OPEN_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let outcome = match app.get_webview_window(WINDOW_LABEL) {
        Some(window) => reveal(&window).map(|()| "brought to the front"),
        None => create(app).map(|()| "opened"),
    };
    match outcome {
        Ok(outcome) => {
            log::info!("[activity-window] {outcome}");
            Ok(())
        }
        Err(error) => {
            log::error!("[activity-window] could not open the window: {error}");
            Err(format!("activity_window_failed: {error}"))
        }
    }
}

fn reveal(window: &WebviewWindow) -> tauri::Result<()> {
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()
}

fn create(app: &AppHandle) -> tauri::Result<()> {
    let builder =
        WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
            .title(WINDOW_TITLE)
            .inner_size(WINDOW_SIZE.0, WINDOW_SIZE.1)
            .min_inner_size(WINDOW_MIN_SIZE.0, WINDOW_MIN_SIZE.1)
            .center();
    // Windows attaches the app menu to every new window, so the window stays hidden until the
    // menu bar is gone and never flashes it.
    #[cfg(target_os = "windows")]
    let builder = builder.visible(false);

    let window = builder.build()?;
    #[cfg(target_os = "windows")]
    {
        detach_menu(&window);
        window.show()?;
    }
    window.set_focus()
}

/// The Photos, Albums and Share items act on the main window's selection, which the log window
/// has no part in. macOS has one shared menu bar instead, which `is_focused` guards.
#[cfg(target_os = "windows")]
fn detach_menu(window: &WebviewWindow) {
    if let Err(error) = window.remove_menu() {
        log::warn!("[activity-window] could not remove the menu bar: {error}");
        if let Err(error) = window.hide_menu() {
            log::warn!("[activity-window] could not hide the menu bar either: {error}");
        }
    }
}

/// Without the main window the app has nothing left to show, so closing it takes the log
/// window with it instead of leaving the app running with only a log.
fn close_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
            return;
        };
        log::info!("[activity-window] closing together with the main window");
        if let Err(error) = window.destroy() {
            log::warn!("[activity-window] could not close with the main window: {error}");
        }
    });
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let label = window.label();
    match event {
        WindowEvent::Focused(focused) if label == WINDOW_LABEL => {
            FOCUSED.store(*focused, Ordering::Release);
        }
        WindowEvent::Destroyed if label == WINDOW_LABEL => {
            FOCUSED.store(false, Ordering::Release);
            log::info!("[activity-window] closed");
        }
        WindowEvent::Destroyed if label == MAIN_WINDOW_LABEL => {
            // Window teardown is still running, so the other window is closed from a task.
            close_in_background(window.app_handle());
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn capability(source: &str) -> Value {
        serde_json::from_str(source).expect("capability files are valid JSON")
    }

    fn string_list(value: &Value, key: &str) -> Vec<String> {
        value[key]
            .as_array()
            .unwrap_or_else(|| panic!("{key} is missing"))
            .iter()
            .map(|item| item.as_str().expect("entries are strings").to_owned())
            .collect()
    }

    #[test]
    fn the_log_window_has_its_own_capability() {
        let log_window = capability(include_str!("../capabilities/activity-log.json"));
        assert_eq!(string_list(&log_window, "windows"), [WINDOW_LABEL]);
        let permissions = string_list(&log_window, "permissions");
        assert!(
            permissions.contains(&"core:window:allow-set-title".to_owned()),
            "the window sets its localized title: {permissions:?}"
        );
    }

    #[test]
    fn the_main_capability_does_not_cover_the_log_window() {
        let main = capability(include_str!("../capabilities/default.json"));
        assert_eq!(string_list(&main, "windows"), [MAIN_WINDOW_LABEL]);
    }
}
