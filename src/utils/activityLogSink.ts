// The app-wide Activity Log sink: batches entries and reports them to the Rust core through the
// RAW Tauri `invoke` (not the logging wrapper in `src/api/invoke.ts`, which would log the logging).
// Outside Tauri (plain browser, unit tests) everything is a quiet no-op.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ActivityLevel } from "../types/activityLog";
import { createActivitySink, type ActivityExtra } from "./activitySinkCore";

export { createActivitySink };
export type { ActivityExtra };

const VERBOSE_EVENT = "activity-log:verbose";

function runningUnderTauri(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

const sink = createActivitySink({
  send: (entries) => invoke("record_frontend_activity", { entries }),
  schedule: (task, delayMs) => {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
  now: () => Date.now(),
  isEnabled: runningUnderTauri,
});

async function loadInitialVerbose(): Promise<void> {
  try {
    const info = await invoke<{ verbose?: unknown } | null>("get_activity_log_info");
    if (typeof info?.verbose === "boolean") sink.setVerbose(info.verbose);
  } catch {
    // The log is best-effort: the flag is also refreshed by every successful batch.
  }
}

async function followVerboseChanges(): Promise<void> {
  try {
    await listen<unknown>(VERBOSE_EVENT, (event) => {
      if (typeof event.payload === "boolean") sink.setVerbose(event.payload);
    });
  } catch {
    // Without the event the flag still refreshes from each batch response.
  }
}

function flushWhenHidden(): void {
  if (typeof window === "undefined") return;
  const flush = () => {
    void sink.flush();
  };
  window.addEventListener("pagehide", flush);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
}

let started = false;

/** Idempotent; called lazily by `logActivity` and explicitly at startup. */
export function startActivitySink(): void {
  if (started || !runningUnderTauri()) return;
  started = true;
  void loadInitialVerbose();
  void followVerboseChanges();
  flushWhenHidden();
}

export function logActivity(
  level: ActivityLevel,
  category: string,
  message: string,
  extra?: ActivityExtra,
): void {
  try {
    startActivitySink();
    sink.log(level, category, message, extra);
  } catch {
    // Logging must never break the caller.
  }
}

export function isActivityVerbose(): boolean {
  return sink.isVerbose();
}

export function flushActivity(): Promise<void> {
  return sink.flush();
}
