import type { ShortcutActionId, ShortcutBindings } from "./catalog";
import { getNativeAccelerator } from "./combo";

/**
 * Submenu titles of the native menu bar. Windows has Photos, Albums and Share; `menu.edit`,
 * `menu.view` and `menu.window` exist on macOS only.
 */
export const MENU_SUBMENU_IDS = [
  "menu.photos",
  "menu.albums",
  "menu.share",
  "menu.edit",
  "menu.view",
  "menu.window",
] as const;
export type MenuSubmenuId = (typeof MENU_SUBMENU_IDS)[number];

/** Shortcut actions that have a native menu item. A menu item's id is its action id. */
export const MENU_ACTION_IDS = [
  "photo.favorite",
  "photo.delete",
  "photo.addToAlbum",
  "album.create",
  "nav.albums",
  "photo.share",
  "photo.copyToClipboard",
  "photo.showInFolder",
  "photo.copyToFolder",
  "nav.settings",
] as const satisfies readonly ShortcutActionId[];
export type MenuActionId = (typeof MENU_ACTION_IDS)[number];

/** Standard system items. They keep their native behavior; only their text is localized. */
export const MENU_SYSTEM_IDS = [
  "system.about",
  "system.services",
  "system.hide",
  "system.hideOthers",
  "system.showAll",
  "system.quit",
  "system.undo",
  "system.redo",
  "system.cut",
  "system.copy",
  "system.paste",
  "system.selectAll",
  "system.fullscreen",
  "system.minimize",
  "system.zoom",
  "system.closeWindow",
] as const;
export type MenuSystemId = (typeof MENU_SYSTEM_IDS)[number];

export interface AppMenuLabels {
  submenus: Readonly<Record<MenuSubmenuId, string>>;
  items: Readonly<Record<MenuActionId, string>>;
  system: Readonly<Record<MenuSystemId, string>>;
}

/**
 * One native menu update. The native side owns the menu structure and applies entries by id:
 * `accelerator` and `enabled` only exist for action items, and `accelerator: null` clears it.
 */
export interface AppMenuEntry {
  id: string;
  label: string;
  accelerator?: string | null;
  enabled?: boolean;
}

export interface AppMenuState {
  labels: AppMenuLabels;
  bindings: ShortcutBindings;
  availableActionIds: ReadonlySet<ShortcutActionId>;
  /**
   * Withhold native accelerators while a text field has focus or a shortcut is being recorded:
   * on macOS a key the page declines is offered to the menu, so typing could trigger an action.
   */
  acceleratorsSuspended: boolean;
}

export function buildAppMenuEntries(state: AppMenuState): AppMenuEntry[] {
  const { labels, bindings, availableActionIds, acceleratorsSuspended } = state;
  const entries: AppMenuEntry[] = [];

  for (const id of MENU_SUBMENU_IDS) {
    entries.push({ id, label: labels.submenus[id] });
  }
  for (const id of MENU_SYSTEM_IDS) {
    entries.push({ id, label: labels.system[id] });
  }
  for (const id of MENU_ACTION_IDS) {
    entries.push({
      id,
      label: labels.items[id],
      accelerator: acceleratorsSuspended ? null : getNativeAccelerator(bindings[id]),
      enabled: availableActionIds.has(id),
    });
  }
  return entries;
}

/** Whether the same entries would produce the same native menu, so a sync can be skipped. */
export function appMenuEntriesEqual(
  left: readonly AppMenuEntry[],
  right: readonly AppMenuEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        entry.id === other.id &&
        entry.label === other.label &&
        entry.accelerator === other.accelerator &&
        entry.enabled === other.enabled
      );
    })
  );
}
