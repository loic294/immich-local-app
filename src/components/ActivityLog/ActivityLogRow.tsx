import { useActivityLogLabels } from "../../i18n/activityLog";
import type { ActivityLevel, ActivityRow } from "../../types/activityLog";
import { formatDuration, formatEntryTime } from "../../utils/activityLogFormat";

const LEVEL_BADGE: Record<ActivityLevel, string> = {
  error: "badge-error",
  warn: "badge-warning",
  info: "badge-info badge-soft",
  debug: "badge-ghost",
};

const LEVEL_ROW: Record<ActivityLevel, string> = {
  error: "border-error bg-error/10",
  warn: "border-warning bg-warning/10",
  info: "border-transparent",
  debug: "border-transparent text-base-content/70",
};

interface ActivityLogRowProps {
  row: ActivityRow;
}

export function ActivityLogRow({ row }: ActivityLogRowProps) {
  const labels = useActivityLogLabels();
  const origin = `${row.source}/${row.category}`;
  const duration = row.durationMs === undefined ? null : formatDuration(row.durationMs);
  const olderTint =
    row.previousSession && (row.level === "info" || row.level === "debug") ? "bg-base-200/60" : "";

  return (
    <div
      data-level={row.level}
      className={`flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-l-2 px-3 py-1 text-xs ${LEVEL_ROW[row.level]} ${olderTint}`}
    >
      <span className="w-[6.5rem] shrink-0 font-mono tabular-nums text-base-content/70">
        {formatEntryTime(row.timestampMs)}
      </span>
      <span
        className={`badge badge-xs w-12 shrink-0 font-mono uppercase ${LEVEL_BADGE[row.level]}`}
      >
        {row.level}
      </span>
      <span className="w-36 shrink-0 truncate font-mono text-base-content/70" title={origin}>
        {origin}
      </span>
      <span className="min-w-0 flex-1 basis-72 font-mono break-words whitespace-pre-wrap select-text">
        {row.message}
      </span>
      {duration !== null || row.slow ? (
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {duration !== null ? (
            <span className="font-mono tabular-nums text-base-content/70">{duration}</span>
          ) : null}
          {row.slow ? (
            <span
              className="badge badge-warning badge-xs font-semibold"
              title={duration !== null ? labels.slowBadgeTitle(duration) : labels.slowBadge}
            >
              {labels.slowBadge}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
