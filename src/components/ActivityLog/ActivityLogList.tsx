import type { ActivityListItem } from "../../types/activityLog";
import { ActivityLogEmptyState } from "./ActivityLogEmptyState";
import { ActivityLogVirtualList } from "./ActivityLogVirtualList";

interface ActivityLogListProps {
  items: readonly ActivityListItem[];
  /** Entries the window holds before filtering: tells "nothing logged" from "all filtered out". */
  totalCount: number;
  /** Changing this (new filters) makes the list follow the newest entry again. */
  resetKey: unknown;
  onResetFilters: () => void;
}

export function ActivityLogList({
  items,
  totalCount,
  resetKey,
  onResetFilters,
}: ActivityLogListProps) {
  return (
    <div className="relative min-h-0 flex-1 bg-base-100">
      {items.length === 0 ? (
        <div className="absolute inset-0">
          <ActivityLogEmptyState
            variant={totalCount === 0 ? "empty" : "no-match"}
            onResetFilters={onResetFilters}
          />
        </div>
      ) : (
        <ActivityLogVirtualList items={items} resetKey={resetKey} />
      )}
    </div>
  );
}
