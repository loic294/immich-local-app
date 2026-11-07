use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{LogicalSize, Manager, PhysicalPosition, WindowEvent};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct Placement {
    width: f64,
    height: f64,
    x: i32,
    y: i32,
    #[serde(default)]
    maximized: bool,
}

impl Placement {
    fn is_valid(&self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width > 0.0 && self.height > 0.0
    }

    fn title_bar_on_monitor(
        &self,
        origin: PhysicalPosition<i32>,
        size: tauri::PhysicalSize<u32>,
        scale: f64,
    ) -> bool {
        let left = f64::from(self.x).max(f64::from(origin.x));
        let right = (f64::from(self.x) + self.width * scale)
            .min(f64::from(origin.x) + f64::from(size.width));
        right - left >= 64.0 * scale
            && self.y >= origin.y
            && f64::from(self.y) + 32.0 * scale <= f64::from(origin.y) + f64::from(size.height)
    }
}

struct WindowState {
    path: PathBuf,
    placement: Mutex<Option<Placement>>,
    capture_pending: AtomicBool,
}

fn load(path: &Path) -> Result<Option<Placement>, Box<dyn std::error::Error>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let placement: Placement = serde_json::from_slice(&bytes)?;
    if !placement.is_valid() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid window dimensions").into());
    }
    Ok(Some(placement))
}

fn write(path: &Path, placement: &Placement) -> Result<(), Box<dyn std::error::Error>> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing config directory"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec(placement)?)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn logical_size(width: u32, height: u32, title_bar_height: u32, scale: f64) -> (f64, f64) {
    (
        f64::from(width) / scale,
        f64::from(height.saturating_sub(title_bar_height)) / scale,
    )
}

fn capture(
    window: &tauri::WebviewWindow,
    previous: Option<Placement>,
) -> tauri::Result<Option<Placement>> {
    if window.is_minimized()? || window.is_fullscreen()? {
        return Ok(previous);
    }
    if window.is_maximized()? {
        return Ok(previous.map(|mut placement| {
            placement.maximized = true;
            placement
        }));
    }
    let position = window.outer_position()?;
    let scale = window.scale_factor()?;
    #[cfg(target_os = "macos")]
    let (width, height) = {
        // Overlay webviews include the title bar, but set_size uses the content rect.
        let size = window.outer_size()?;
        let title_bar_height = (window.inner_position()?.y - position.y).max(0) as u32;
        logical_size(size.width, size.height, title_bar_height, scale)
    };
    #[cfg(not(target_os = "macos"))]
    let (width, height) = {
        let size = window.inner_size()?;
        logical_size(size.width, size.height, 0, scale)
    };
    let placement = Placement {
        width,
        height,
        x: position.x,
        y: position.y,
        maximized: false,
    };
    Ok(if placement.is_valid() {
        Some(placement)
    } else {
        log::warn!("[window-state] ignoring non-positive window dimensions");
        previous
    })
}

pub fn initialize(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let path = app.path().app_config_dir()?.join("window-state.json");
    let saved = match load(&path) {
        Ok(saved) => saved,
        Err(error) => {
            log::error!("[window-state] failed to read saved placement: {error}");
            None
        }
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "main window is missing"))?;
    if let Some(placement) = &saved {
        let restore = || -> tauri::Result<()> {
            window.set_size(LogicalSize::new(placement.width, placement.height))?;
            let scale = window.scale_factor()?;
            let monitors = window.available_monitors()?;
            if monitors.iter().any(|monitor| {
                placement.title_bar_on_monitor(*monitor.position(), *monitor.size(), scale)
            }) {
                window.set_position(PhysicalPosition::new(placement.x, placement.y))?;
            } else {
                log::info!("[window-state] saved screen is unavailable; centering window");
                window.center()?;
            }
            if placement.maximized {
                window.maximize()?;
            }
            Ok(())
        };
        match restore() {
            Ok(()) => log::info!(
                "[window-state] restored {}x{} at {},{} maximized={}",
                placement.width,
                placement.height,
                placement.x,
                placement.y,
                placement.maximized
            ),
            Err(error) => log::error!("[window-state] failed to restore placement: {error}"),
        }
    } else {
        log::info!("[window-state] no saved placement; using initial window size");
    }
    let placement = capture(&window, saved)?;
    app.manage(WindowState {
        path,
        placement: Mutex::new(placement),
        capture_pending: AtomicBool::new(false),
    });
    Ok(())
}

fn update_placement(
    state: &WindowState,
    read_window: impl FnOnce(Option<Placement>) -> tauri::Result<Option<Placement>>,
) {
    let previous = match state.placement.lock() {
        Ok(placement) => placement.clone(),
        Err(error) => {
            log::error!("[window-state] placement lock failed: {error}");
            return;
        }
    };
    let current = match read_window(previous) {
        Ok(current) => current,
        Err(error) => {
            log::error!("[window-state] failed to capture placement: {error}");
            return;
        }
    };
    match state.placement.lock() {
        Ok(mut placement) => *placement = current,
        Err(error) => log::error!("[window-state] placement lock failed: {error}"),
    }
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != "main"
        || !matches!(
            event,
            WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. }
        )
    {
        return;
    }
    if matches!(event, WindowEvent::CloseRequested { .. }) {
        save(window.app_handle());
        return;
    }
    let Some(state) = window.try_state::<WindowState>() else {
        return;
    };
    let Some(webview) = window.app_handle().get_webview_window("main") else {
        return;
    };
    if state.capture_pending.swap(true, Ordering::AcqRel) {
        return;
    }
    // Native move/resize callbacks must return before querying window geometry.
    tauri::async_runtime::spawn_blocking(move || {
        let state = webview.state::<WindowState>();
        update_placement(&state, |previous| capture(&webview, previous));
        state.capture_pending.store(false, Ordering::Release);
    });
}

pub fn save(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<WindowState>() else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        update_placement(&state, |previous| capture(&window, previous));
    }
    let placement = match state.placement.lock() {
        Ok(placement) => placement.clone(),
        Err(error) => {
            log::error!("[window-state] placement lock failed on exit: {error}");
            return;
        }
    };
    if let Some(placement) = placement.as_ref() {
        match write(&state.path, placement) {
            Ok(()) => log::info!("[window-state] saved placement"),
            Err(error) => log::error!("[window-state] failed to save placement: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placement() -> Placement {
        Placement {
            width: 1100.0,
            height: 720.0,
            x: -1200,
            y: 100,
            maximized: false,
        }
    }

    #[test]
    fn native_geometry_queries_allow_reentrant_window_events() {
        let state = WindowState {
            path: PathBuf::new(),
            placement: Mutex::new(Some(placement())),
            capture_pending: AtomicBool::new(false),
        };
        update_placement(&state, |previous| {
            assert!(
                state.placement.try_lock().is_ok(),
                "native geometry queries must not hold the window-state lock"
            );
            Ok(previous)
        });
    }

    #[test]
    fn overlay_content_size_does_not_grow_on_restore() {
        assert_eq!(logical_size(2560, 1800, 56, 2.0), (1280.0, 872.0));
        assert_eq!(logical_size(2560, 1800, 0, 2.0), (1280.0, 900.0));
    }

    #[test]
    fn validates_saved_dimensions() {
        let mut saved = placement();
        assert!(saved.is_valid());
        saved.width = 0.0;
        assert!(!saved.is_valid());
        saved.width = f64::INFINITY;
        assert!(!saved.is_valid());
        saved.width = 1100.0;
        saved.height = -1.0;
        assert!(!saved.is_valid());
    }

    #[test]
    fn keeps_negative_monitor_positions_and_rejects_unreachable_title_bars() {
        let saved = placement();
        let size = tauri::PhysicalSize::new(1920, 1080);
        assert!(saved.title_bar_on_monitor(PhysicalPosition::new(-1920, 0), size, 1.0));
        assert!(!saved.title_bar_on_monitor(PhysicalPosition::new(0, 0), size, 1.0));
        assert!(!saved.title_bar_on_monitor(PhysicalPosition::new(-1920, 200), size, 1.0));
    }

    #[test]
    fn persists_and_replaces_window_placement() {
        let path = std::env::temp_dir().join(format!(
            "immich-window-state-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert!(load(&path).unwrap().is_none());
        let mut saved = placement();
        write(&path, &saved).unwrap();
        assert_eq!(load(&path).unwrap(), Some(saved.clone()));
        saved.maximized = true;
        saved.x = 200;
        write(&path, &saved).unwrap();
        assert_eq!(load(&path).unwrap(), Some(saved));
        fs::write(&path, b"invalid json").unwrap();
        assert!(load(&path).is_err());
        fs::remove_file(path).unwrap();
    }
}
