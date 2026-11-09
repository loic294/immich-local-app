// Mirrors `console.*` into the Activity Log. It wraps whichever implementation is installed when
// it runs (the production file logger patches the console first), calls it first, then records.
import type { ActivityLevel } from "../types/activityLog";
import { isActivityVerbose, logActivity } from "./activityLogSink";
import { stringifyArg } from "./stringifyArg";

type ConsoleMethod = "error" | "warn" | "info" | "log" | "debug";

const LEVELS: Record<ConsoleMethod, ActivityLevel> = {
  error: "error",
  warn: "warn",
  info: "info",
  log: "debug",
  debug: "debug",
};

const DEFAULT_CATEGORY = "app";
const RESERVED_CATEGORY = "session";
const MAX_CATEGORY_CHARS = 24;
const LEADING_TAG = /^\s*\[([A-Za-z][A-Za-z0-9_:.-]{0,63})\]/;

// The toast stack reports every toast itself (kind + key), so its console echo is a duplicate.
const ECHOED_ELSEWHERE = ["[toasts] push"];

// Survives a re-evaluated module (hot reload), so the console is never wrapped twice.
const WRAPPED = Symbol.for("immich-local.activity-console-wrapper");

/** `[sync.prepare] …` -> `sync`, `[oauth:ui:callback] …` -> `oauth`; anything else -> `app`. */
export function consoleCategory(message: string): string {
  const tag = LEADING_TAG.exec(message)?.[1];
  const segment = tag?.split(/[:.]/)[0].toLowerCase().slice(0, MAX_CATEGORY_CHARS);
  return segment && segment !== RESERVED_CATEGORY ? segment : DEFAULT_CATEGORY;
}

function renderArg(arg: unknown): string {
  try {
    const text = stringifyArg(arg);
    return typeof text === "string" ? text : String(arg);
  } catch {
    return "<unprintable>";
  }
}

function isEchoedElsewhere(args: readonly unknown[]): boolean {
  const first = args[0];
  return typeof first === "string" && ECHOED_ELSEWHERE.some((prefix) => first.startsWith(prefix));
}

// Anything the capture itself triggers (even a console call) must not be recorded again.
let recording = false;

function record(level: ActivityLevel, args: readonly unknown[]): void {
  if (recording) return;
  recording = true;
  try {
    // Checked before rendering: debug lines are the chattiest and are dropped unless Verbose.
    if (level === "debug" && !isActivityVerbose()) return;
    if (isEchoedElsewhere(args)) return;
    const message = args.map(renderArg).join(" ");
    if (message.trim() === "") return;
    logActivity(level, consoleCategory(message), message);
  } catch {
    // Capturing must never disturb the code that logged.
  } finally {
    recording = false;
  }
}

type MarkedFunction = ((...args: unknown[]) => void) & { [WRAPPED]?: true };

function wrap(target: Console, method: ConsoleMethod): void {
  const previous = target[method] as MarkedFunction | undefined;
  if (typeof previous !== "function" || previous[WRAPPED]) return;
  const level = LEVELS[method];
  const wrapper: MarkedFunction = (...args) => {
    try {
      previous.apply(target, args);
    } finally {
      record(level, args);
    }
  };
  wrapper[WRAPPED] = true;
  try {
    target[method] = wrapper;
  } catch {
    // A locked-down console is left untouched.
  }
}

export function installConsoleCapture(target: Console = console): void {
  for (const method of Object.keys(LEVELS) as ConsoleMethod[]) {
    wrap(target, method);
  }
}
