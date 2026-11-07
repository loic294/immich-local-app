import { invoke } from "@tauri-apps/api/core";
import type { AppMenuEntry } from "../shortcuts/appMenu";

/** Emitted by the native menu with the id of the clicked item (which is a shortcut action id). */
export const APP_MENU_ACTION_EVENT = "app-menu-action";

/** Applies labels, accelerators, and enabled state to the native menu bar built at startup. */
export const updateAppMenu = (entries: AppMenuEntry[]) =>
  invoke<void>("update_app_menu", { entries });
