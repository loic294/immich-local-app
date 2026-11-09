import { Search, X } from "lucide-react";
import { useActivityLogLabels } from "../../i18n/activityLog";
import type { ActivityFilters } from "../../types/activityLog";
import { ALL_CATEGORIES, TIME_RANGES, isActivityTimeRange } from "../../utils/activityLogFilter";

interface ActivityLogFiltersProps {
  filters: ActivityFilters;
  categories: readonly string[];
  onChange: (filters: ActivityFilters) => void;
}

export function ActivityLogFilters({ filters, categories, onChange }: ActivityLogFiltersProps) {
  const labels = useActivityLogLabels();

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <select
        className="select select-sm w-auto max-w-44"
        aria-label={labels.category}
        value={filters.category}
        onChange={(event) => onChange({ ...filters, category: event.target.value })}
      >
        <option value={ALL_CATEGORIES}>{labels.allCategories}</option>
        {categories.map((category) => (
          <option key={category} value={category}>
            {category}
          </option>
        ))}
      </select>
      <label className="input input-sm min-w-40 flex-1">
        <Search size={14} className="opacity-60" aria-hidden="true" />
        <input
          type="text"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          aria-label={labels.search}
          placeholder={labels.searchPlaceholder}
          value={filters.search}
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filters.search !== "") {
              event.preventDefault();
              onChange({ ...filters, search: "" });
            }
          }}
        />
        {filters.search !== "" ? (
          <button
            type="button"
            className="btn btn-ghost btn-circle btn-xs"
            aria-label={labels.clearSearch}
            onClick={() => onChange({ ...filters, search: "" })}
          >
            <X size={12} aria-hidden="true" />
          </button>
        ) : null}
      </label>
      <select
        className="select select-sm w-auto"
        aria-label={labels.range}
        value={filters.range}
        onChange={(event) => {
          const range = event.target.value;
          if (isActivityTimeRange(range)) onChange({ ...filters, range });
        }}
      >
        {TIME_RANGES.map((range) => (
          <option key={range} value={range}>
            {labels.ranges[range]}
          </option>
        ))}
      </select>
      <label
        className="flex cursor-pointer items-center gap-2 text-xs"
        title={labels.slowOnlyTitle}
      >
        <input
          type="checkbox"
          className="toggle toggle-sm"
          checked={filters.slowOnly}
          onChange={(event) => onChange({ ...filters, slowOnly: event.target.checked })}
        />
        {labels.slowOnly}
      </label>
    </div>
  );
}
