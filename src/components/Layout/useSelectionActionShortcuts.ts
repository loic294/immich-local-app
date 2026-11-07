import type { ShortcutScope } from "../../shortcuts/catalog";
import { useShortcutHandlers } from "../../shortcuts/useShortcutHandler";

interface SelectionActionShortcutOptions {
  scope: ShortcutScope;
  /** False while nothing is selected, which switches every action off. */
  enabled: boolean;
  addToAlbum: () => void;
  shareWithLink: () => void;
  /** Leave the optional actions undefined while they cannot run, e.g. a copy is in progress. */
  copyToClipboard?: () => void;
  showInFolder?: () => void;
  copyToFolder?: () => void;
  fixTime?: () => void;
}

/** Registers the shortcuts for the album, share and file actions of a selection. */
export function useSelectionActionShortcuts({
  scope,
  enabled,
  addToAlbum,
  shareWithLink,
  copyToClipboard,
  showInFolder,
  copyToFolder,
  fixTime,
}: SelectionActionShortcutOptions): void {
  useShortcutHandlers(
    {
      "photo.addToAlbum": addToAlbum,
      "photo.share": shareWithLink,
      "photo.copyToClipboard": copyToClipboard,
      "photo.showInFolder": showInFolder,
      "photo.copyToFolder": copyToFolder,
      "photo.fixTime": fixTime,
    },
    { enabled, scope },
  );
}
