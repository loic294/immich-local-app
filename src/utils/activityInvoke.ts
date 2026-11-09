// Wraps a Tauri `invoke` so every command is recorded in the Activity Log with its duration and
// outcome. All logging is best-effort: the wrapped call's result or error always reaches the
// caller untouched, and a logging problem can never turn into an app failure.
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import type { ActivityLevel } from "../types/activityLog";
import { summarizeActivityArgs } from "./activityArgs";
import {
  PENDING_COMMAND_MS,
  classifyInvokeFailure,
  classifyInvokeSuccess,
  describeError,
  failureMessage,
  isUnloggedCommand,
  pendingMessage,
  successMessage,
} from "./activityInvokePolicy";

export const COMMAND_CATEGORY = "command";

export type InvokeFunction = <T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
) => Promise<T>;

export interface InvokeLogDeps {
  log: (
    level: ActivityLevel,
    category: string,
    message: string,
    extra?: { durationMs?: number; slow?: boolean },
  ) => void;
  isVerbose: () => boolean;
  now: () => number;
  setTimer: (task: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Called with the error text of every failure that was logged. */
  rememberError: (text: string) => void;
}

interface CallTracker {
  succeeded(): void;
  failed(error: unknown): void;
}

function ignoreFailures(action: () => void): void {
  try {
    action();
  } catch {
    // Logging must never break the command call.
  }
}

const NOT_TRACKED: CallTracker = { succeeded() {}, failed() {} };

function trackCall(command: string, args: unknown, deps: InvokeLogDeps): CallTracker {
  try {
    return startTracking(command, args, deps);
  } catch {
    return NOT_TRACKED;
  }
}

function startTracking(command: string, args: unknown, deps: InvokeLogDeps): CallTracker {
  const startedAt = deps.now();
  let summary: string | undefined;
  // Only summarised when an entry is actually written: hot read commands skip the work.
  const argsSummary = () => (summary ??= summarizeActivityArgs(args));
  let timer: unknown;
  let hasTimer = false;
  ignoreFailures(() => {
    timer = deps.setTimer(
      () =>
        ignoreFailures(() =>
          deps.log("warn", COMMAND_CATEGORY, pendingMessage(command, argsSummary())),
        ),
      PENDING_COMMAND_MS,
    );
    hasTimer = true;
  });
  const stopTimer = () =>
    ignoreFailures(() => {
      if (hasTimer) deps.clearTimer(timer);
    });

  return {
    succeeded() {
      stopTimer();
      ignoreFailures(() => {
        const outcome = classifyInvokeSuccess(command, deps.now() - startedAt);
        if (outcome.level === "debug" && !deps.isVerbose()) return;
        deps.log(
          outcome.level,
          COMMAND_CATEGORY,
          successMessage(command, argsSummary(), outcome.durationMs),
          { durationMs: outcome.durationMs, slow: outcome.slow },
        );
      });
    },
    failed(error) {
      stopTimer();
      ignoreFailures(() => {
        const text = describeError(error);
        ignoreFailures(() => deps.rememberError(text));
        const outcome = classifyInvokeFailure(text, deps.now() - startedAt);
        deps.log(
          outcome.level,
          COMMAND_CATEGORY,
          failureMessage(command, argsSummary(), outcome.durationMs, text),
          { durationMs: outcome.durationMs, slow: outcome.slow },
        );
      });
    },
  };
}

export function withActivityLogging(call: InvokeFunction, deps: InvokeLogDeps): InvokeFunction {
  async function logged<T>(
    command: string,
    args?: InvokeArgs,
    options?: InvokeOptions,
  ): Promise<T> {
    const tracker = trackCall(command, args, deps);
    try {
      const value = await call<T>(command, args, options);
      tracker.succeeded();
      return value;
    } catch (error) {
      tracker.failed(error);
      throw error;
    }
  }

  return function invokeWithLogging<T>(
    command: string,
    args?: InvokeArgs,
    options?: InvokeOptions,
  ): Promise<T> {
    if (isUnloggedCommand(command)) return call<T>(command, args, options);
    return logged<T>(command, args, options);
  };
}
