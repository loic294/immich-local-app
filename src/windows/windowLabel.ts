import { getCurrentWindow } from "@tauri-apps/api/window";

/** Must equal `WINDOW_LABEL` in `src-tauri/src/activity_window.rs` (a test enforces it). */
export const ACTIVITY_LOG_WINDOW_LABEL = "activity-log";
/** Must equal the label of the first window in `src-tauri/tauri.conf.json`. */
export const MAIN_WINDOW_LABEL = "main";

/** Label of the Tauri window this page runs in. Outside Tauri (a browser, tests) it is the main window. */
export function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return MAIN_WINDOW_LABEL;
  }
}

export function isActivityLogWindow(label: string = currentWindowLabel()): boolean {
  return label === ACTIVITY_LOG_WINDOW_LABEL;
}
