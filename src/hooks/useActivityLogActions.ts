import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard, openLogFolder } from "../api/activityLog";
import type { ActivityFilters, ActivityInfo, ActivityRow } from "../types/activityLog";
import { describeActivityError } from "../utils/activityLogError";
import { exportedEntryCount, formatCopyText } from "../utils/activityLogFormat";

const LOG_PREFIX = "[activity-log:ui]";
const STATUS_VISIBLE_MS = 3000;

/** What the toolbar's status line reports; the component turns it into localised text. */
export type ActivityActionStatus =
  | { kind: "copied"; count: number }
  | { kind: "copy-failed" }
  | { kind: "open-failed" };

export interface UseActivityLogActionsInput {
  /** The filtered view, oldest first. */
  visibleRows: readonly ActivityRow[];
  /** Everything the window holds, before filtering. */
  totalCount: number;
  info: ActivityInfo | null;
  filters: ActivityFilters;
}

export interface ActivityLogActions {
  status: ActivityActionStatus | null;
  copy: () => Promise<void>;
  openFolder: () => Promise<void>;
}

export function useActivityLogActions({
  visibleRows,
  totalCount,
  info,
  filters,
}: UseActivityLogActionsInput): ActivityLogActions {
  const [status, setStatus] = useState<ActivityActionStatus | null>(null);
  const mountedRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const show = useCallback((next: ActivityActionStatus) => {
    if (!mountedRef.current) return;
    setStatus(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setStatus(null);
    }, STATUS_VISIBLE_MS);
  }, []);

  const copy = useCallback(async () => {
    const count = exportedEntryCount(visibleRows.length);
    console.info(`${LOG_PREFIX} copying ${count} of ${visibleRows.length} shown entries`);
    try {
      const text = formatCopyText({
        entries: visibleRows,
        info,
        filters,
        totalCount,
        now: new Date(),
      });
      await copyTextToClipboard(text);
      show({ kind: "copied", count });
    } catch (error) {
      console.error(`${LOG_PREFIX} copy failed: ${describeActivityError(error)}`);
      show({ kind: "copy-failed" });
    }
  }, [visibleRows, info, filters, totalCount, show]);

  const openFolder = useCallback(async () => {
    const path = info?.logDir;
    if (!path) return;
    console.info(`${LOG_PREFIX} opening the log folder`);
    try {
      await openLogFolder(path);
    } catch (error) {
      console.error(`${LOG_PREFIX} opening the log folder failed: ${describeActivityError(error)}`);
      show({ kind: "open-failed" });
    }
  }, [info, show]);

  return { status, copy, openFolder };
}
