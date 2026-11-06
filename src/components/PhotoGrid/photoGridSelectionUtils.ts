import type { GridLayoutSection } from "../../types";

/** How much of a layout section (the photos under one day separator) is selected. */
export type SectionSelectionState = "none" | "some" | "all";

/**
 * IDs of every asset laid out in a section, in grid order. The layout covers
 * assets that are not loaded yet, so this can be larger than the loaded set.
 */
export function getSectionAssetIds(section: GridLayoutSection): string[] {
  const ids: string[] = [];
  for (const row of section.rows) {
    for (const item of row.items) {
      ids.push(item.id);
    }
  }
  return ids;
}

/** Tri-state selection of a section. An empty section is never selected. */
export function getSectionSelectionState(
  section: GridLayoutSection,
  selectedIds: ReadonlySet<string>,
): SectionSelectionState {
  if (selectedIds.size === 0) {
    return "none";
  }

  let total = 0;
  let selected = 0;
  for (const row of section.rows) {
    for (const item of row.items) {
      total += 1;
      if (selectedIds.has(item.id)) {
        selected += 1;
      }
    }
  }

  if (selected === 0) {
    return "none";
  }

  return selected === total ? "all" : "some";
}

/**
 * Keeps the selected IDs that are still loaded or still part of the layout.
 * Day selection can include assets whose page has not loaded, so a selection
 * must survive while the layout still lists those assets, and only drop IDs
 * that disappeared from both (filter change, deletion, ...).
 *
 * Returns the same Set instance when nothing needs to be dropped so callers can
 * skip a state update. The layout is only scanned when the selection contains
 * IDs that are not loaded, and the scan stops as soon as all of them are found.
 */
export function retainKnownAssetIds(
  selectedIds: Set<string>,
  isLoaded: (assetId: string) => boolean,
  sections: readonly GridLayoutSection[],
): Set<string> {
  const unloadedIds = new Set<string>();
  for (const id of selectedIds) {
    if (!isLoaded(id)) {
      unloadedIds.add(id);
    }
  }

  if (unloadedIds.size === 0) {
    return selectedIds;
  }

  const laidOutIds = new Set<string>();
  scan: for (const section of sections) {
    for (const row of section.rows) {
      for (const item of row.items) {
        if (unloadedIds.has(item.id)) {
          laidOutIds.add(item.id);
          if (laidOutIds.size === unloadedIds.size) {
            break scan;
          }
        }
      }
    }
  }

  if (laidOutIds.size === unloadedIds.size) {
    return selectedIds;
  }

  const next = new Set<string>();
  for (const id of selectedIds) {
    if (isLoaded(id) || laidOutIds.has(id)) {
      next.add(id);
    }
  }
  return next;
}
