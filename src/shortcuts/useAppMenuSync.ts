import { useEffect, useRef, useState } from "react";
import { updateAppMenu } from "../api/appMenu";
import { useShortcutLabels } from "../i18n/shortcuts";
import { appMenuEntriesEqual, buildAppMenuEntries, type AppMenuEntry } from "./appMenu";
import type { ShortcutActionId, ShortcutBindings } from "./catalog";
import { shortcutRegistry } from "./shortcutRegistry";
import { useAcceleratorsSuspended } from "./useAcceleratorsSuspended";

const SYNC_DELAY_MS = 40;
const UNSUPPORTED_PLATFORM_PREFIX = "unsupported_platform:";

function sameMembers(left: ReadonlySet<ShortcutActionId>, right: ReadonlySet<ShortcutActionId>) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function useAvailableActionIds(): ReadonlySet<ShortcutActionId> {
  const [available, setAvailable] = useState(() => shortcutRegistry.getAvailableActionIds());
  useEffect(() => {
    const refresh = () =>
      setAvailable((previous) => {
        const next = shortcutRegistry.getAvailableActionIds();
        return sameMembers(previous, next) ? previous : next;
      });
    refresh();
    return shortcutRegistry.subscribeAvailability(refresh);
  }, []);
  return available;
}

/**
 * Keeps the native menu bar in step with the app: localized labels, the current shortcut
 * bindings as accelerators, and which items apply to the current view.
 */
export function useAppMenuSync(bindings: ShortcutBindings): void {
  const labels = useShortcutLabels().menu;
  const availableActionIds = useAvailableActionIds();
  const acceleratorsSuspended = useAcceleratorsSuspended();
  const lastApplied = useRef<AppMenuEntry[] | null>(null);
  const unsupported = useRef(false);

  useEffect(() => {
    if (unsupported.current) {
      return undefined;
    }
    const entries = buildAppMenuEntries({
      labels,
      bindings,
      availableActionIds,
      acceleratorsSuspended,
    });
    if (lastApplied.current && appMenuEntriesEqual(lastApplied.current, entries)) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      updateAppMenu(entries)
        .then(() => {
          lastApplied.current = entries;
        })
        .catch((error: unknown) => {
          const message = String(error);
          if (message.startsWith(UNSUPPORTED_PLATFORM_PREFIX)) {
            unsupported.current = true;
            console.info(`[menu] native menu is not available on this platform: ${message}`);
            return;
          }
          console.warn("[menu] could not update the native menu:", error);
        });
    }, SYNC_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [labels, bindings, availableActionIds, acceleratorsSuspended]);
}
