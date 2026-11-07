import { isMacPlatform } from "../utils/platform";
import { blurEditable, getShortcutContext, isEditableTarget, isModalOpen } from "./dom";
import { createShortcutRegistry } from "./registry";

export const IS_MAC = isMacPlatform();

/** The app-wide registry: every shortcut and native menu action is dispatched through it. */
export const shortcutRegistry = createShortcutRegistry({
  isMac: IS_MAC,
  getContext: getShortcutContext,
  isModalOpen,
  isEditableTarget,
  blurEditable,
});
