import type { ActivityActionStatus } from "../../hooks/useActivityLogActions";
import type { ActivityFilters, LevelCounts } from "../../types/activityLog";
import { toggleLevel } from "../../utils/activityLogFilter";
import { ActivityLevelChips } from "./ActivityLevelChips";
import { ActivityLogActionBar } from "./ActivityLogActionBar";
import { ActivityLogFilters } from "./ActivityLogFilters";
import { ActivityLogToggles } from "./ActivityLogToggles";

interface ActivityLogToolbarProps {
  filters: ActivityFilters;
  onFiltersChange: (filters: ActivityFilters) => void;
  levelCounts: LevelCounts;
  categories: readonly string[];
  historyEnabled: boolean;
  historyLoading: boolean;
  onHistoryChange: (enabled: boolean) => void;
  verbose: boolean;
  onVerboseChange: (enabled: boolean) => void;
  shownCount: number;
  totalCount: number;
  status: ActivityActionStatus | null;
  canCopy: boolean;
  canOpenFolder: boolean;
  onCopy: () => void;
  onClear: () => void;
  onOpenFolder: () => void;
}

export function ActivityLogToolbar({
  filters,
  onFiltersChange,
  levelCounts,
  categories,
  historyEnabled,
  historyLoading,
  onHistoryChange,
  verbose,
  onVerboseChange,
  shownCount,
  totalCount,
  status,
  canCopy,
  canOpenFolder,
  onCopy,
  onClear,
  onOpenFolder,
}: ActivityLogToolbarProps) {
  return (
    <header className="shrink-0 space-y-2 border-b border-base-300 bg-base-200 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ActivityLevelChips
          levels={filters.levels}
          counts={levelCounts}
          onToggle={(level) => onFiltersChange(toggleLevel(filters, level))}
        />
        <ActivityLogFilters filters={filters} categories={categories} onChange={onFiltersChange} />
      </div>
      <ActivityLogToggles
        historyEnabled={historyEnabled}
        historyLoading={historyLoading}
        onHistoryChange={onHistoryChange}
        verbose={verbose}
        onVerboseChange={onVerboseChange}
      />
      <ActivityLogActionBar
        shownCount={shownCount}
        totalCount={totalCount}
        status={status}
        canCopy={canCopy}
        canOpenFolder={canOpenFolder}
        onCopy={onCopy}
        onClear={onClear}
        onOpenFolder={onOpenFolder}
      />
    </header>
  );
}
