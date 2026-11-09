// Reports uncaught errors and unhandled promise rejections (which otherwise only reach the
// devtools console) to the Activity Log.
import { wasInvokeErrorLogged } from "../api/invoke";
import { logActivity } from "./activityLogSink";
import { stringifyArg } from "./stringifyArg";

const CATEGORY = "app";
const MAX_MESSAGE_CHARS = 1200;
const MAX_STACK_LINES = 6;

interface ErrorEventLike {
  message?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
  error?: unknown;
}

function clip(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function describeError(error: Error): string {
  const stack = typeof error.stack === "string" ? error.stack : "";
  // V8 stacks start with "Name: message"; JavaScriptCore stacks hold only the frames.
  const text =
    error.message && stack.includes(error.message)
      ? stack
      : `${error.name}: ${error.message}\n${stack}`;
  return text.split("\n").slice(0, MAX_STACK_LINES).join("\n").trim();
}

function describeThrown(value: unknown): string {
  try {
    if (value instanceof Error) return describeError(value);
    const text = stringifyArg(value);
    return typeof text === "string" ? text : String(value);
  } catch {
    return "<unprintable>";
  }
}

function location(event: ErrorEventLike): string {
  if (typeof event.filename !== "string" || event.filename === "") return "";
  const file = event.filename.split(/[?#]/)[0];
  return ` (at ${file}:${String(event.lineno ?? "?")}:${String(event.colno ?? "?")})`;
}

/** Returns null for browser notices that are not application errors. */
export function formatUncaughtError(event: ErrorEventLike): string | null {
  const message = typeof event.message === "string" ? event.message : "";
  if (message.startsWith("ResizeObserver loop")) return null;
  const detail =
    event.error !== undefined && event.error !== null
      ? describeThrown(event.error)
      : `${message || "unknown error"}${location(event)}`;
  return clip(`uncaught error: ${detail}`);
}

export function formatUnhandledRejection(reason: unknown): string {
  return clip(`unhandled rejection: ${describeThrown(reason)}`);
}

/** Returns a function that removes the listeners again. */
export function installWindowErrorCapture(target: EventTarget = window): () => void {
  const onError = (event: Event) => {
    try {
      const message = formatUncaughtError(event as ErrorEvent);
      if (message) logActivity("error", CATEGORY, message);
    } catch {
      // Capturing must never raise another error.
    }
  };
  const onRejection = (event: Event) => {
    try {
      const reason = (event as PromiseRejectionEvent).reason;
      // A failed Tauri command was already recorded, with its duration, by the invoke wrapper.
      if (wasInvokeErrorLogged(reason)) return;
      logActivity("error", CATEGORY, formatUnhandledRejection(reason));
    } catch {
      // Capturing must never raise another error.
    }
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
