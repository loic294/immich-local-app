import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { APP_MENU_ACTION_EVENT } from "../api/appMenu";
import { isShortcutActionId } from "./catalog";
import { shortcutRegistry } from "./shortcutRegistry";

/** Routes native menu clicks into the same registry that handles keyboard shortcuts. */
export function useAppMenuEvents(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    listen<string>(APP_MENU_ACTION_EVENT, (event) => {
      const actionId = event.payload;
      if (!isShortcutActionId(actionId)) {
        console.warn("[menu] ignored an unknown menu action:", actionId);
        return;
      }
      shortcutRegistry.dispatch(actionId, "menu");
    })
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch((error: unknown) => {
        console.warn("[menu] could not listen for native menu actions:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
