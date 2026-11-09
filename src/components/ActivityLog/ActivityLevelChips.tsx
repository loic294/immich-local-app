import { useActivityLogLabels } from "../../i18n/activityLog";
import type { ActivityLevel, LevelCounts } from "../../types/activityLog";
import { ACTIVITY_LEVELS } from "../../utils/activityLogFilter";

const ACTIVE_CLASS: Record<ActivityLevel, string> = {
  error: "btn-error",
  warn: "btn-warning",
  info: "btn-info",
  debug: "btn-neutral",
};

interface ActivityLevelChipsProps {
  levels: ReadonlySet<ActivityLevel>;
  /** Entries per level under every other filter, so a hidden level still shows how many it holds. */
  counts: LevelCounts;
  onToggle: (level: ActivityLevel) => void;
}

export function ActivityLevelChips({ levels, counts, onToggle }: ActivityLevelChipsProps) {
  const labels = useActivityLogLabels();

  return (
    <div
      role="group"
      aria-label={labels.levelGroup}
      className="flex flex-wrap items-center gap-1.5"
    >
      {ACTIVITY_LEVELS.map((level) => {
        const active = levels.has(level);
        return (
          <button
            key={level}
            type="button"
            aria-pressed={active}
            className={`btn btn-xs gap-1.5 ${
              active ? ACTIVE_CLASS[level] : "btn-ghost border-base-300 text-base-content/70"
            }`}
            onClick={() => onToggle(level)}
          >
            {labels.levelNames[level]}
            <span className="font-mono tabular-nums opacity-80">
              {labels.formatNumber(counts[level])}
            </span>
          </button>
        );
      })}
    </div>
  );
}
