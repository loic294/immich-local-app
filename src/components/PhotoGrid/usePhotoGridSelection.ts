import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetSummary, GridLayoutSection } from "../../types";
import type { SelectionCommand } from "./PhotoGrid.types";
import {
  getSectionAssetIds,
  getSectionSelectionState,
  retainKnownAssetIds,
  type SectionSelectionState,
} from "./photoGridSelectionUtils";

type ApplySelectionModifiers = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

type UsePhotoGridSelectionParams = {
  displayAssets: AssetSummary[];
  /** Layout sections (one per day separator), including assets that are not loaded yet. */
  layoutSections: GridLayoutSection[];
  selectionCommand?: SelectionCommand;
  onSelectedCountChange?: (count: number) => void;
  onSelectedIdsChange?: (ids: string[]) => void;
};

export function usePhotoGridSelection({
  displayAssets,
  layoutSections,
  selectionCommand,
  onSelectedCountChange,
  onSelectedIdsChange,
}: UsePhotoGridSelectionParams) {
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorIndex, setSelectionAnchorIndex] = useState<number | null>(null);
  const handledSelectionCommandRef = useRef(0);
  const assetIndexById = useMemo(
    () => new Map(displayAssets.map((asset, index) => [asset.id, index] as const)),
    [displayAssets],
  );

  useEffect(() => {
    setSelectedAssetIds((current) =>
      retainKnownAssetIds(current, (id) => assetIndexById.has(id), layoutSections),
    );
  }, [assetIndexById, layoutSections]);

  useEffect(() => {
    onSelectedCountChange?.(selectedAssetIds.size);
  }, [onSelectedCountChange, selectedAssetIds]);

  useEffect(() => {
    onSelectedIdsChange?.(Array.from(selectedAssetIds));
  }, [onSelectedIdsChange, selectedAssetIds]);

  useEffect(() => {
    if (!selectionCommand) {
      return;
    }

    if (selectionCommand.nonce === handledSelectionCommandRef.current) {
      return;
    }

    handledSelectionCommandRef.current = selectionCommand.nonce;

    if (selectionCommand.type === "clear") {
      setSelectedAssetIds(new Set());
      setSelectionAnchorIndex(null);
      return;
    }

    if (selectionCommand.type === "select-all") {
      const next = new Set(displayAssets.map((asset) => asset.id));
      setSelectedAssetIds(next);
      setSelectionAnchorIndex(displayAssets.length > 0 ? 0 : null);
    }
  }, [displayAssets, selectionCommand]);

  const applySelection = (assetId: string, index: number, modifiers: ApplySelectionModifiers) => {
    const isToggle = modifiers.metaKey || modifiers.ctrlKey;

    if (modifiers.shiftKey) {
      const anchor = selectionAnchorIndex !== null ? selectionAnchorIndex : index;
      const start = Math.min(anchor, index);
      const end = Math.max(anchor, index);
      const rangeIds = displayAssets.slice(start, end + 1).map((asset) => asset.id);

      setSelectedAssetIds((current) => {
        const next = isToggle ? new Set(current) : new Set<string>();
        for (const id of rangeIds) {
          next.add(id);
        }
        return next;
      });
      setSelectionAnchorIndex(index);
      return;
    }

    if (isToggle) {
      setSelectedAssetIds((current) => {
        const next = new Set(current);
        if (next.has(assetId)) {
          next.delete(assetId);
        } else {
          next.add(assetId);
        }
        return next;
      });
      setSelectionAnchorIndex(index);
      return;
    }

    setSelectedAssetIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) {
        next.delete(assetId);
      } else {
        next.add(assetId);
      }
      return next;
    });
    setSelectionAnchorIndex(index);
  };

  const getSectionState = (sectionIndex: number): SectionSelectionState => {
    const section = layoutSections[sectionIndex];
    return section ? getSectionSelectionState(section, selectedAssetIds) : "none";
  };

  /**
   * Selects every photo under a day separator, or deselects them when they are
   * all selected already. The layout lists photos whose page is not loaded yet,
   * so the whole day is covered even while only part of it is in memory.
   */
  const toggleSectionSelection = (sectionIndex: number) => {
    const section = layoutSections[sectionIndex];
    if (!section) {
      console.warn("[PhotoGrid] Day selection ignored: unknown section", { sectionIndex });
      return;
    }

    const assetIds = getSectionAssetIds(section);
    const shouldSelect = getSectionSelectionState(section, selectedAssetIds) !== "all";
    console.log("[PhotoGrid] Day selection toggled", {
      sectionIndex,
      sectionKey: section.key,
      assetCount: assetIds.length,
      selected: shouldSelect,
    });

    setSelectedAssetIds((current) => {
      const next = new Set(current);
      for (const id of assetIds) {
        if (shouldSelect) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return next;
    });
  };

  return {
    selectedAssetIds,
    assetIndexById,
    applySelection,
    getSectionSelectionState: getSectionState,
    toggleSectionSelection,
  };
}
