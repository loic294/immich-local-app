import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetSummary } from "../../types";
import type { SelectionCommand } from "./PhotoGrid.types";

type ApplySelectionModifiers = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

type UsePhotoGridSelectionParams = {
  displayAssets: AssetSummary[];
  selectionCommand?: SelectionCommand;
  onSelectedCountChange?: (count: number) => void;
  onSelectedIdsChange?: (ids: string[]) => void;
};

export function usePhotoGridSelection({
  displayAssets,
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
    setSelectedAssetIds((current) => {
      if (current.size === 0) {
        return current;
      }

      const next = new Set<string>();
      for (const id of current) {
        if (assetIndexById.has(id)) {
          next.add(id);
        }
      }

      if (next.size === current.size) {
        return current;
      }

      return next;
    });
  }, [assetIndexById]);

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

  return {
    selectedAssetIds,
    assetIndexById,
    applySelection,
  };
}
