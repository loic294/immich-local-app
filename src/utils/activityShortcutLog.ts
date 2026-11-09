// Records every shortcut / native-menu action that ran as a `ui` Activity Log entry.
import type { ShortcutActionEvent } from "../shortcuts/registry";
import { logActivity } from "./activityLogSink";

export interface ShortcutActionSource {
  onAction(listener: (event: ShortcutActionEvent) => void): () => void;
}

export function shortcutActivityMessage(event: ShortcutActionEvent): string {
  return `action ${event.actionId} via ${event.source}`;
}

export function installShortcutActivityLog(registry: ShortcutActionSource): () => void {
  return registry.onAction((event) => {
    try {
      logActivity("info", "ui", shortcutActivityMessage(event));
    } catch {
      // Logging must never disturb shortcut handling.
    }
  });
}
