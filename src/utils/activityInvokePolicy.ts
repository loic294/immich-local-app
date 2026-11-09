// Pure rules for how the logging `invoke` wrapper reports a Tauri command: which commands are
// never logged, which are routine reads (quiet unless Verbose is on), and how a call is worded.
import type { ActivityLevel } from "../types/activityLog";

export const SLOW_COMMAND_MS = 500;
export const PENDING_COMMAND_MS = 5000;

const MAX_ERROR_CHARS = 500;

// The log window polls these; logging them would make the log feed itself.
const UNLOGGED_COMMANDS = new Set([
  "get_activity_log_entries",
  "get_activity_log_history",
  "get_activity_log_info",
  "record_frontend_activity",
  "set_activity_log_verbose",
  "clear_activity_log",
  "open_activity_log_window",
]);

const READ_PREFIXES = [
  "get_",
  "list_",
  "check_",
  "read_",
  "is_",
  "has_",
  "can_",
  "find_",
  "search_",
  "query_",
  "load_",
  "count_",
  "peek_",
  "resolve_",
  "calculate_",
];

// Named like reads, but they sync, download or create something the user cares about.
const ACTION_COMMANDS = new Set([
  "check_for_new_assets",
  "get_or_create_album_share_link",
  "get_oauth_authorization_url",
  "get_asset_playback",
]);

// Housekeeping that fires on every navigation or menu change.
const ROUTINE_COMMANDS = new Set(["update_app_menu", "track_media_event", "record_recent_album"]);

export interface InvokeOutcome {
  level: ActivityLevel;
  durationMs: number;
  slow: boolean;
}

export function isUnloggedCommand(command: string): boolean {
  return command.startsWith("plugin:") || UNLOGGED_COMMANDS.has(command);
}

/** Routine commands only appear in the log when Verbose is on (as long as they are fast). */
export function isRoutineCommand(command: string): boolean {
  if (ROUTINE_COMMANDS.has(command)) return true;
  if (ACTION_COMMANDS.has(command)) return false;
  return READ_PREFIXES.some((prefix) => command.startsWith(prefix));
}

/** Whole, non-negative milliseconds: the Rust side rejects fractional durations. */
export function wholeMs(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
}

/** `1480` -> `1,480ms`, matching how the Rust side words durations. */
export function formatDurationMs(ms: number): string {
  return `${String(wholeMs(ms)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}ms`;
}

export function describeError(error: unknown): string {
  let text: string;
  try {
    const message =
      typeof error === "object" && error !== null
        ? (error as { message?: unknown }).message
        : undefined;
    text = typeof message === "string" ? message : String(error);
  } catch {
    text = "unprintable error";
  }
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/** Offline is an expected state in this local-first app, not an application bug. */
export function isOfflineError(text: string): boolean {
  return /^\s*offline:/i.test(text);
}

export function classifyInvokeSuccess(command: string, elapsedMs: number): InvokeOutcome {
  const durationMs = wholeMs(elapsedMs);
  const slow = durationMs >= SLOW_COMMAND_MS;
  const level: ActivityLevel = slow ? "warn" : isRoutineCommand(command) ? "debug" : "info";
  return { level, durationMs, slow };
}

export function classifyInvokeFailure(errorText: string, elapsedMs: number): InvokeOutcome {
  const durationMs = wholeMs(elapsedMs);
  return {
    level: isOfflineError(errorText) ? "warn" : "error",
    durationMs,
    slow: durationMs >= SLOW_COMMAND_MS,
  };
}

function callLabel(command: string, argsSummary: string): string {
  return `${command}(${argsSummary})`;
}

export function successMessage(command: string, argsSummary: string, durationMs: number): string {
  return `${callLabel(command, argsSummary)} -> ok in ${formatDurationMs(durationMs)}`;
}

export function failureMessage(
  command: string,
  argsSummary: string,
  durationMs: number,
  errorText: string,
): string {
  return `${callLabel(command, argsSummary)} -> failed in ${formatDurationMs(durationMs)}: ${errorText}`;
}

export function pendingMessage(command: string, argsSummary: string): string {
  return `${callLabel(command, argsSummary)} still running after ${formatDurationMs(PENDING_COMMAND_MS)}`;
}
