// Installs everything that feeds the Activity Log from the frontend (besides the `invoke`
// wrapper, which is used directly): console, uncaught errors, shortcut/menu actions, toasts and
// failed React Query requests.
import type { QueryClient } from "@tanstack/react-query";
import { shortcutRegistry } from "../shortcuts/shortcutRegistry";
import { subscribeToToastEvents } from "../toasts/toastStore";
import { installConsoleCapture } from "./activityConsole";
import { startActivitySink } from "./activityLogSink";
import { observeQueryClient } from "./activityQueryLog";
import { installShortcutActivityLog } from "./activityShortcutLog";
import { installToastActivityLog } from "./activityToastLog";
import { installWindowErrorCapture } from "./activityWindowErrors";

export interface ActivityCaptureOptions {
  /** Failed queries and mutations of this client are reported (category `query`). */
  queryClient?: QueryClient;
}

let installed = false;

// One failing source must not keep the others (or the app) from starting.
function attempt(install: () => unknown): void {
  try {
    install();
  } catch {
    // Capturing is best-effort.
  }
}

/**
 * Idempotent and safe in every window that shares `src/main.tsx`. Call it right after
 * `setupFileLogging()` (the console is wrapped on top of whatever it installed) and pass the
 * app's `QueryClient` once it exists; a client is observed at most once, so a later call that
 * only adds the client is fine too.
 */
export function setupActivityCapture(options: ActivityCaptureOptions = {}): void {
  if (!installed) {
    installed = true;
    attempt(startActivitySink);
    attempt(() => installConsoleCapture());
    attempt(() => installWindowErrorCapture());
    attempt(() => installShortcutActivityLog(shortcutRegistry));
    attempt(() => installToastActivityLog(subscribeToToastEvents));
  }
  const { queryClient } = options;
  if (queryClient) attempt(() => observeQueryClient(queryClient));
}
