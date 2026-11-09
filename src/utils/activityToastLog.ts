// Records each toast as a `ui` Activity Log entry. Only the kind and the i18n key are logged,
// never the rendered message text (it can carry file or album names).
import type { ToastEvent, ToastKind } from "../toasts/toastStore";
import type { ActivityLevel } from "../types/activityLog";
import { logActivity } from "./activityLogSink";

const MAX_KEY_CHARS = 80;

export function toastActivityLevel(kind: ToastKind): ActivityLevel {
  return kind === "error" || kind === "warning" ? "warn" : "info";
}

/** `toast error: asset.deleteFailed`, with ` ×3` appended when several were coalesced. */
export function toastActivityMessage(event: ToastEvent): string {
  const base = `toast ${event.kind}: ${String(event.key).slice(0, MAX_KEY_CHARS)}`;
  return event.count > 1 ? `${base} ×${event.count}` : base;
}

export function installToastActivityLog(
  subscribe: (listener: (event: ToastEvent) => void) => () => void,
): () => void {
  return subscribe((event) => {
    try {
      logActivity(toastActivityLevel(event.kind), "ui", toastActivityMessage(event));
    } catch {
      // Logging must never disturb the toast stack.
    }
  });
}
