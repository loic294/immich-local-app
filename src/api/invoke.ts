import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { withActivityLogging } from "../utils/activityInvoke";
import { describeError } from "../utils/activityInvokePolicy";
import { isActivityVerbose, logActivity } from "../utils/activityLogSink";
import { createRecentErrorSet } from "../utils/recentErrorSet";

// Every Tauri command goes through this wrapper so the Activity Log records its duration and
// outcome. Import `invoke` from here, never from `@tauri-apps/api/core` (a test enforces it).
const recentErrors = createRecentErrorSet();

const loggedInvoke = withActivityLogging(tauriInvoke, {
  log: logActivity,
  isVerbose: isActivityVerbose,
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimer: (task, delayMs) => setTimeout(task, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  rememberError: (text) => recentErrors.remember(text),
});

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  return loggedInvoke<T>(cmd, args, options);
}

/** True when this error was just recorded by the wrapper, so callers can avoid logging it again. */
export function wasInvokeErrorLogged(error: unknown): boolean {
  try {
    return recentErrors.has(describeError(error));
  } catch {
    return false;
  }
}
