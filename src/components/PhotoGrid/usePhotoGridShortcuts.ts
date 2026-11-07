import { getMediaEditState, requestMediaEdit } from "../../api/media";
import { useShortcutHandlers } from "../../shortcuts/useShortcutHandler";
import type { AssetSummary } from "../../types";
import { isVideoAsset } from "./photoGridUtils";

interface PhotoGridShortcutOptions {
  /** The photo open in the viewer, or null while the grid is showing. */
  activeAsset: AssetSummary | null;
  /** Whether photos are selected in the grid. */
  hasSelection: boolean;
  closeViewer: () => void;
  showPrevious: () => void;
  showNext: () => void;
  toggleActiveFavorite: () => void;
  deleteActive: () => void;
  setActiveRating: (rating: number | null) => void;
  toggleInfoPanel: () => void;
  favoriteSelection: () => void;
}

function editActiveAsset(asset: AssetSummary): boolean {
  const originalId = asset.stackOriginalId ?? asset.id;
  const state = getMediaEditState();
  if (state.phase !== "idle" || state.imports[originalId]) {
    console.info("[shortcuts] edit ignored while another edit is in progress", {
      assetId: asset.id,
    });
    return false;
  }
  requestMediaEdit([asset.id]);
  return true;
}

/**
 * Connects the shared photo grid and its viewer to the global shortcut handler. Registrations
 * follow the grid state, so a key only acts when its action applies and the matching native menu
 * item is only enabled then too.
 */
export function usePhotoGridShortcuts({
  activeAsset,
  hasSelection,
  closeViewer,
  showPrevious,
  showNext,
  toggleActiveFavorite,
  deleteActive,
  setActiveRating,
  toggleInfoPanel,
  favoriteSelection,
}: PhotoGridShortcutOptions): void {
  const viewing = activeAsset !== null;
  // Restoring stays an explicit action in the viewer, so the Delete key never undoes a deletion.
  const canDelete = viewing && !activeAsset.isArchived && !activeAsset.isTrashed;
  const canEdit = viewing && !isVideoAsset(activeAsset);

  // Pressing the rating that is already set clears it, like tapping the same star again.
  const rate = (rating: number) => setActiveRating(activeAsset?.rating === rating ? null : rating);

  useShortcutHandlers(
    {
      "view.close": closeViewer,
      "view.previous": showPrevious,
      "view.next": showNext,
      "photo.favorite": toggleActiveFavorite,
      "photo.delete": canDelete ? deleteActive : undefined,
      "photo.toggleInfo": toggleInfoPanel,
      "photo.edit": canEdit ? () => editActiveAsset(activeAsset) : undefined,
      "photo.rate0": () => setActiveRating(null),
      "photo.rate1": () => rate(1),
      "photo.rate2": () => rate(2),
      "photo.rate3": () => rate(3),
      "photo.rate4": () => rate(4),
      "photo.rate5": () => rate(5),
    },
    { enabled: viewing, scope: "viewer" },
  );

  useShortcutHandlers(
    { "photo.favorite": hasSelection ? favoriteSelection : undefined },
    { scope: "browse" },
  );
}
