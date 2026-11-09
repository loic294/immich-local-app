import { useCallback, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { useFollowLatest } from "../../hooks/useFollowLatest";
import { useActivityLogLabels } from "../../i18n/activityLog";
import type { ActivityListItem } from "../../types/activityLog";
import { countEntriesAfter, estimateItemHeight } from "../../utils/activityLogItems";
import { ActivityLogDivider } from "./ActivityLogDivider";
import { ActivityLogRow } from "./ActivityLogRow";

const OVERSCAN_ROWS = 12;
/** Lets the very first render fill a viewport before the real one has been measured. */
const INITIAL_VIEWPORT = { width: 960, height: 640 };

interface ActivityLogVirtualListProps {
  items: readonly ActivityListItem[];
  /** Changing this (new filters) resumes following the newest entry. */
  resetKey: unknown;
}

/** Renders only the rows near the viewport, so 10,000 entries stay cheap to scroll. */
export function ActivityLogVirtualList({ items, resetKey }: ActivityLogVirtualListProps) {
  const labels = useActivityLogLabels();
  const containerRef = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(() => containerRef.current, []);
  const estimateSize = useCallback((index: number) => estimateItemHeight(items[index]), [items]);
  const getItemKey = useCallback((index: number) => items[index]?.key ?? index, [items]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN_ROWS,
    initialRect: INITIAL_VIEWPORT,
  });
  const totalSize = virtualizer.getTotalSize();
  const latestKey = items.length > 0 ? items[items.length - 1].key : null;
  const { following, pausedAtKey, onScroll, jumpToLatest } = useFollowLatest({
    containerRef,
    contentHeight: totalSize,
    latestKey,
    resetSignal: resetKey,
  });
  const newCount = following || pausedAtKey === null ? null : countEntriesAfter(items, pausedAtKey);

  return (
    <>
      <div
        ref={containerRef}
        role="log"
        aria-live="off"
        aria-label={labels.listLabel}
        tabIndex={0}
        onScroll={onScroll}
        className="absolute inset-0 overflow-x-hidden overflow-y-auto select-text [overflow-anchor:none] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      >
        <div className="relative w-full" style={{ height: totalSize }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = items[virtualItem.index];
            if (item === undefined) return null;
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {item.kind === "entry" ? (
                  <ActivityLogRow row={item.row} />
                ) : (
                  <ActivityLogDivider item={item} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!following ? (
        <button
          type="button"
          className="btn btn-primary btn-sm absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg"
          onClick={jumpToLatest}
        >
          <ArrowDown size={14} aria-hidden="true" />
          {labels.jumpToLatest}
          {newCount !== null && newCount > 0 ? (
            <span className="tabular-nums opacity-80">· {labels.newEntries(newCount)}</span>
          ) : null}
        </button>
      ) : null}
    </>
  );
}
