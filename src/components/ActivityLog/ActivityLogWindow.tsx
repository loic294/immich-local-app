import { useCallback, useEffect, useState } from "react";
import { setActivityLogWindowTitle } from "../../api/activityLog";
import { useActivityLog } from "../../hooks/useActivityLog";
import { useActivityLogActions } from "../../hooks/useActivityLogActions";
import { useActivityLogView } from "../../hooks/useActivityLogView";
import { useClearLogDialog } from "../../hooks/useClearLogDialog";
import { useActivityLogLabels } from "../../i18n/activityLog";
import type { ActivityFilters } from "../../types/activityLog";
import { DEFAULT_FILTERS, setLevelEnabled } from "../../utils/activityLogFilter";
import { ActivityLogErrorBanner } from "./ActivityLogErrorBanner";
import { ActivityLogList } from "./ActivityLogList";
import { ActivityLogToolbar } from "./ActivityLogToolbar";
import { ClearLogDialog } from "./ClearLogDialog";

/**
 * Root of the "Activity Log" window: a live, filterable record of what the app did, written to be
 * copied into a chat when something goes wrong. Everything here is local; nothing touches the
 * network.
 */
export function ActivityLogWindow() {
  const labels = useActivityLogLabels();
  const [filters, setFilters] = useState<ActivityFilters>(DEFAULT_FILTERS);
  const log = useActivityLog();
  const view = useActivityLogView({
    entries: log.entries,
    historyEntries: log.historyEntries,
    includeHistory: log.historyEnabled,
    filters,
  });
  const actions = useActivityLogActions({
    visibleRows: view.visibleRows,
    totalCount: view.allRows.length,
    info: log.info,
    filters,
  });
  const describeFailure = useCallback((reason: string) => labels.dialog.failed(reason), [labels]);
  const clearDialog = useClearLogDialog({ clear: log.clear, describeFailure });
  const { setVerbose } = log;
  const { copy, openFolder } = actions;

  useEffect(() => {
    document.title = labels.windowTitle;
    void setActivityLogWindowTitle(labels.windowTitle);
  }, [labels.windowTitle]);

  const resetFilters = useCallback(() => setFilters(DEFAULT_FILTERS), []);

  // Debug entries only exist while verbose is on, so turning it on also reveals them.
  const handleVerboseChange = useCallback(
    (enabled: boolean) => {
      void setVerbose(enabled).then((effective) => {
        if (enabled && effective) setFilters((current) => setLevelEnabled(current, "debug", true));
      });
    },
    [setVerbose],
  );
  const handleCopy = useCallback(() => void copy(), [copy]);
  const handleOpenFolder = useCallback(() => void openFolder(), [openFolder]);
  const handleConfirmClear = useCallback(() => void clearDialog.confirm(), [clearDialog.confirm]);

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <ActivityLogToolbar
        filters={filters}
        onFiltersChange={setFilters}
        levelCounts={view.levelCounts}
        categories={view.categories}
        historyEnabled={log.historyEnabled}
        historyLoading={log.historyLoading}
        onHistoryChange={log.setHistoryEnabled}
        verbose={log.verbose}
        onVerboseChange={handleVerboseChange}
        shownCount={view.visibleRows.length}
        totalCount={view.allRows.length}
        status={actions.status}
        canCopy={view.visibleRows.length > 0}
        canOpenFolder={Boolean(log.info?.logDir)}
        onCopy={handleCopy}
        onClear={clearDialog.request}
        onOpenFolder={handleOpenFolder}
      />
      {log.error ? <ActivityLogErrorBanner error={log.error} /> : null}
      <ActivityLogList
        items={view.items}
        totalCount={view.allRows.length}
        resetKey={filters}
        onResetFilters={resetFilters}
      />
      <footer className="shrink-0 border-t border-base-300 bg-base-200 px-3 py-1.5 text-xs text-base-content/70">
        {labels.footerNote}
      </footer>
      {clearDialog.open ? (
        <ClearLogDialog
          busy={clearDialog.busy}
          error={clearDialog.error}
          onConfirm={handleConfirmClear}
          onClose={clearDialog.cancel}
        />
      ) : null}
    </div>
  );
}
