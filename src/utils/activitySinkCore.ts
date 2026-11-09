// Batching queue between the webview and the Rust activity log. It is pure (no Tauri imports): the
// transport, timer and clock are injected, so the batching rules are testable on their own.
// It must never report its own problems through `console.*` -- the console is captured into the
// log, so that would feed back into itself.
import type { ActivityLevel } from "../types/activityLog";

export const FLUSH_DELAY_MS = 250;
export const MAX_BATCH_ENTRIES = 200;
export const MAX_QUEUED_ENTRIES = 2000;

const MAX_MESSAGE_CHARS = 8000;
const MAX_CATEGORY_CHARS = 48;

export interface ActivitySinkEntry {
  timestampMs: number;
  level: ActivityLevel;
  category: string;
  message: string;
  durationMs?: number;
  slow?: boolean;
}

export interface ActivityExtra {
  durationMs?: number;
  slow?: boolean;
}

export interface ActivitySinkDeps {
  /** Delivers one batch; the resolved value may carry the backend's `verbose` flag. */
  send: (entries: ActivitySinkEntry[]) => Promise<unknown>;
  /** Runs `task` once after `delayMs` and returns a function that cancels it. */
  schedule: (task: () => void, delayMs: number) => () => void;
  now: () => number;
  /** When false (not running under Tauri) every call is a quiet no-op. */
  isEnabled?: () => boolean;
}

export interface ActivitySink {
  log(level: ActivityLevel, category: string, message: string, extra?: ActivityExtra): void;
  /** Resolves once everything queued so far has been handed to `send`; never rejects. */
  flush(): Promise<void>;
  isVerbose(): boolean;
  setVerbose(verbose: boolean): void;
}

function reportedVerbose(response: unknown): boolean | null {
  if (typeof response !== "object" || response === null) return null;
  const verbose = (response as { verbose?: unknown }).verbose;
  return typeof verbose === "boolean" ? verbose : null;
}

function droppedNotice(count: number, timestampMs: number): ActivitySinkEntry {
  return {
    timestampMs,
    level: "warn",
    category: "app",
    message: `${count} activity ${count === 1 ? "entry" : "entries"} dropped`,
  };
}

export function createActivitySink(deps: ActivitySinkDeps): ActivitySink {
  const queue: ActivitySinkEntry[] = [];
  const idleWaiters: Array<() => void> = [];
  let verbose = false;
  let dropped = 0;
  let sending = false;
  let cancelTimer: (() => void) | null = null;

  function enabled(): boolean {
    try {
      return deps.isEnabled ? deps.isEnabled() : true;
    } catch {
      return false;
    }
  }

  function clearTimer(): void {
    const cancel = cancelTimer;
    cancelTimer = null;
    if (cancel) cancel();
  }

  function armTimer(): void {
    if (cancelTimer) return;
    cancelTimer = deps.schedule(() => {
      cancelTimer = null;
      pump();
    }, FLUSH_DELAY_MS);
  }

  function releaseIdleWaiters(): void {
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function onSent(response: unknown): void {
    const reported = reportedVerbose(response);
    if (reported !== null) verbose = reported;
    if (dropped > 0) {
      queue.push(droppedNotice(dropped, deps.now()));
      dropped = 0;
    }
  }

  // Sends one batch at a time, and keeps going until the queue is empty.
  function pump(): void {
    if (sending) return;
    clearTimer();
    if (queue.length === 0) {
      releaseIdleWaiters();
      return;
    }
    const batch = queue.splice(0, MAX_BATCH_ENTRIES);
    sending = true;
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(deps.send(batch));
    } catch (error) {
      request = Promise.reject(error);
    }
    const settle = () => {
      sending = false;
      try {
        pump();
      } catch {
        releaseIdleWaiters();
      }
    };
    request
      .then(onSent, () => {
        dropped += batch.length;
      })
      .then(settle, settle);
  }

  return {
    log(level, category, message, extra) {
      try {
        if (!enabled()) return;
        if (level === "debug" && !verbose) return;
        const entry: ActivitySinkEntry = {
          timestampMs: Math.round(deps.now()),
          level,
          category: category.slice(0, MAX_CATEGORY_CHARS),
          message:
            message.length > MAX_MESSAGE_CHARS ? message.slice(0, MAX_MESSAGE_CHARS) : message,
        };
        if (extra?.durationMs !== undefined && Number.isFinite(extra.durationMs)) {
          entry.durationMs = Math.max(0, Math.round(extra.durationMs));
        }
        if (extra?.slow) entry.slow = true;
        queue.push(entry);
        if (queue.length > MAX_QUEUED_ENTRIES) {
          const overflow = queue.length - MAX_QUEUED_ENTRIES;
          queue.splice(0, overflow);
          dropped += overflow;
        }
        armTimer();
      } catch {
        // Logging must never break the caller.
      }
    },
    flush() {
      if (!sending && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        pump();
      });
    },
    isVerbose: () => verbose,
    setVerbose(next) {
      verbose = next;
    },
  };
}
