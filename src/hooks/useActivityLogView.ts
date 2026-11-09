import { useEffect, useMemo, useState } from "react";
import type {
  ActivityFilters,
  ActivityListItem,
  ActivityRow,
  LevelCounts,
} from "../types/activityLog";
import { combineRows, findUnexpectedSessionEnds } from "../utils/activityLogBuffer";
import {
  countLevelsIgnoringLevelFilter,
  filterEntries,
  listCategories,
} from "../utils/activityLogFilter";
import { buildListItems } from "../utils/activityLogItems";

/** Relative time ranges are re-evaluated this often, so old entries age out of "last minute". */
const RANGE_REFRESH_MS = 5000;

export interface UseActivityLogViewInput {
  entries: readonly ActivityRow[];
  historyEntries: readonly ActivityRow[];
  includeHistory: boolean;
  filters: ActivityFilters;
}

export interface ActivityLogView {
  /** Everything the window holds, before filtering. */
  allRows: readonly ActivityRow[];
  visibleRows: readonly ActivityRow[];
  levelCounts: LevelCounts;
  categories: string[];
  items: ActivityListItem[];
}

export function useActivityLogView({
  entries,
  historyEntries,
  includeHistory,
  filters,
}: UseActivityLogViewInput): ActivityLogView {
  const [, setRefreshCount] = useState(0);
  const relative = filters.range !== "all";

  useEffect(() => {
    if (!relative) return undefined;
    const timer = window.setInterval(() => setRefreshCount((count) => count + 1), RANGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [relative]);

  // The bucket changes at most every few seconds, which is what re-runs the memos below.
  const nowBucket = relative ? Math.floor(Date.now() / RANGE_REFRESH_MS) * RANGE_REFRESH_MS : 0;

  const allRows = useMemo(
    () => combineRows(historyEntries, entries, includeHistory),
    [historyEntries, entries, includeHistory],
  );
  const unexpectedEnds = useMemo(() => findUnexpectedSessionEnds(allRows), [allRows]);
  const categories = useMemo(
    () => listCategories(allRows, filters.category),
    [allRows, filters.category],
  );
  const visibleRows = useMemo(
    () => filterEntries(allRows, filters, nowBucket),
    [allRows, filters, nowBucket],
  );
  const levelCounts = useMemo(
    () => countLevelsIgnoringLevelFilter(allRows, filters, nowBucket),
    [allRows, filters, nowBucket],
  );
  const items = useMemo(
    () => buildListItems(visibleRows, unexpectedEnds),
    [visibleRows, unexpectedEnds],
  );

  return { allRows, visibleRows, levelCounts, categories, items };
}
