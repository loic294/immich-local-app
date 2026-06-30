import { useMemo } from "react";
import type { GridLayoutSection, TimelineLayoutMonth } from "../../types";
import type { VirtualEntry } from "./PhotoGrid.types";
import { findFirstEntryAtOrAfter, parseDayKey } from "./photoGridUtils";

type UsePhotoGridVirtualLayoutParams = {
  fullGridSections: GridLayoutSection[];
  gridSections: GridLayoutSection[];
  displayAssetIds: string[];
  isUsingFullLayout: boolean;
  viewportHeight: number;
  scrollTop: number;
};

export function usePhotoGridVirtualLayout({
  fullGridSections,
  gridSections,
  displayAssetIds,
  isUsingFullLayout,
  viewportHeight,
  scrollTop,
}: UsePhotoGridVirtualLayoutParams) {
  const { virtualEntries, totalContentHeight, loadedTimelineMonths, sectionTopMap } =
    useMemo(() => {
      const entries: VirtualEntry[] = [];
      const nextSectionTopMap = new Map<string, number>();
      const monthMap = new Map<string, TimelineLayoutMonth>();

      const headerHeight = 52;
      const rowGap = 4;
      const sectionGap = 10;
      let cursor = 0;
      const sectionsForLayout = fullGridSections.length > 0 ? fullGridSections : gridSections;

      for (const section of sectionsForLayout) {
        nextSectionTopMap.set(section.key, cursor);
        entries.push({
          type: "header",
          key: `header-${section.key}`,
          sectionKey: section.key,
          label: section.label,
          top: cursor,
          height: headerHeight,
        });
        cursor += headerHeight;

        section.rows.forEach((row, rowIndex) => {
          entries.push({
            type: "row",
            key: `${section.key}-${rowIndex}`,
            sectionKey: section.key,
            top: cursor,
            height: row.height,
            items: row.items,
          });
          cursor += row.height + rowGap;
        });

        cursor += sectionGap;

        const dayInfo = parseDayKey(section.key);
        if (dayInfo) {
          const monthKey = `${dayInfo.year}-${String(dayInfo.month).padStart(2, "0")}`;
          const month = monthMap.get(monthKey);

          if (month) {
            month.rowCount += section.rows.length;
          } else {
            monthMap.set(monthKey, {
              monthKey,
              jumpDateKey: section.key,
              year: dayInfo.year,
              month: dayInfo.month,
              rowCount: section.rows.length,
            });
          }
        }
      }

      return {
        virtualEntries: entries,
        totalContentHeight: cursor,
        loadedTimelineMonths: [...monthMap.values()],
        sectionTopMap: nextSectionTopMap,
      };
    }, [fullGridSections, gridSections]);

  const visibleEntries = useMemo(() => {
    if (virtualEntries.length === 0) {
      return [];
    }

    const overscan = Math.max(1000, viewportHeight * 1.5);
    const start = Math.max(0, scrollTop - overscan);
    const end = scrollTop + viewportHeight + overscan;

    const startIndex = Math.max(0, findFirstEntryAtOrAfter(virtualEntries, start) - 2);
    const endIndex = Math.min(
      virtualEntries.length,
      findFirstEntryAtOrAfter(virtualEntries, end + 1) + 2,
    );

    return virtualEntries.slice(startIndex, endIndex).filter((entry) => {
      const entryBottom = entry.top + entry.height;
      return entryBottom >= start && entry.top <= end;
    });
  }, [scrollTop, viewportHeight, virtualEntries]);

  const { loadedContentTop, loadedContentBottom } = useMemo(() => {
    if (!isUsingFullLayout || displayAssetIds.length === 0) {
      return { loadedContentTop: 0, loadedContentBottom: totalContentHeight };
    }

    const firstId = displayAssetIds[0];
    const lastId = displayAssetIds[displayAssetIds.length - 1];
    let top: number | null = null;
    let bottom: number | null = null;

    for (const entry of virtualEntries) {
      if (entry.type !== "row") continue;
      if (top === null && entry.items.some((item) => item.id === firstId)) {
        top = entry.top;
      }
      if (entry.items.some((item) => item.id === lastId)) {
        bottom = entry.top + entry.height;
      }
    }

    return {
      loadedContentTop: top ?? 0,
      loadedContentBottom: bottom ?? totalContentHeight,
    };
  }, [displayAssetIds, isUsingFullLayout, totalContentHeight, virtualEntries]);

  return {
    virtualEntries,
    visibleEntries,
    totalContentHeight,
    loadedTimelineMonths,
    loadedContentTop,
    loadedContentBottom,
    sectionTopMap,
  };
}
