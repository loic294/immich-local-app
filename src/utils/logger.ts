import { debug, error, info, trace, warn } from "@tauri-apps/plugin-log";

type ConsoleMethod = "log" | "debug" | "info" | "warn" | "error";
type PluginLogger = (message: string) => Promise<void>;

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function forwardConsole(method: ConsoleMethod, logger: PluginLogger): void {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    // Preserve normal console behavior for the devtools console.
    original(...args);
    const message = args.map(stringifyArg).join(" ");
    // Fire-and-forget: never let a logging failure break the app.
    void logger(message).catch(() => {});
  };
}

let installed = false;

/**
 * In production builds, mirror all `console.*` output into the Tauri log
 * plugin so frontend logs are persisted to files in the Cache Location
 * (`<cache>/logs`) alongside the Rust logs. No-op in development, where the
 * browser/devtools console is used directly.
 */
export function setupFileLogging(): void {
  if (installed || !import.meta.env.PROD) {
    return;
  }
  installed = true;

  // console.log / console.debug are the most verbose, so they map to the
  // lower-severity loggers. console.{info,warn,error} keep their severity.
  forwardConsole("log", info);
  forwardConsole("debug", debug);
  forwardConsole("info", info);
  forwardConsole("warn", warn);
  forwardConsole("error", error);

  // Capture otherwise-unhandled frontend failures in the log file too.
  window.addEventListener("error", (event) => {
    const detail =
      event.error instanceof Error ? stringifyArg(event.error) : event.message;
    void error(`[window.onerror] ${detail}`).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (event) => {
    void error(`[unhandledrejection] ${stringifyArg(event.reason)}`).catch(
      () => {},
    );
  });

  void trace("[logging] frontend console logging attached to file targets");
}
