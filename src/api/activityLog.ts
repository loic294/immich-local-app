// Raw `invoke` is allowed here on purpose: these commands must not log themselves, otherwise
// polling the log would keep writing new entries into it.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  ActivityEntriesRequest,
  ActivityEntriesResponse,
  ActivityEntry,
  ActivityInfo,
} from "../types/activityLog";

export function getActivityLogEntries(
  request: ActivityEntriesRequest,
): Promise<ActivityEntriesResponse> {
  const args =
    request.limit === undefined
      ? { sinceId: request.sinceId }
      : { sinceId: request.sinceId, limit: request.limit };
  return invoke<ActivityEntriesResponse>("get_activity_log_entries", args);
}

/** Entries saved by earlier launches only, oldest first. */
export function getActivityLogHistory(limit?: number): Promise<ActivityEntry[]> {
  return invoke<ActivityEntry[]>("get_activity_log_history", limit === undefined ? {} : { limit });
}

export function getActivityLogInfo(): Promise<ActivityInfo> {
  return invoke<ActivityInfo>("get_activity_log_info");
}

export function setActivityLogVerbose(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_activity_log_verbose", { enabled });
}

/** Wipes the in-memory buffer and the saved log files. */
export function clearActivityLog(): Promise<void> {
  return invoke<void>("clear_activity_log");
}

export function copyTextToClipboard(text: string): Promise<void> {
  return invoke<void>("copy_text_to_clipboard", { text });
}

export function openLogFolder(path: string): Promise<void> {
  return invoke<void>("open_folder_in_file_explorer", { path });
}

/** Best effort: a plain browser (or a missing capability) keeps the default title. */
export async function setActivityLogWindowTitle(title: string): Promise<void> {
  try {
    await getCurrentWindow().setTitle(title);
  } catch {
    // Nothing to do outside the Tauri runtime.
  }
}
