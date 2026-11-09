import { TriangleAlert } from "lucide-react";
import { useI18n } from "../../i18n";
import { useActivityLogLabels } from "../../i18n/activityLog";
import type { ActivityListItem } from "../../types/activityLog";
import { formatDateLabel } from "../../utils/activityLogFormat";

interface ActivityLogDividerProps {
  item: Exclude<ActivityListItem, { kind: "entry" }>;
}

/** A date change or an app-session boundary between two stretches of entries. */
export function ActivityLogDivider({ item }: ActivityLogDividerProps) {
  const { locale } = useI18n();
  const labels = useActivityLogLabels();

  if (item.kind === "date") {
    return (
      <div className="divider my-0 h-8 px-3 text-xs font-medium text-base-content/70">
        {formatDateLabel(item.timestampMs, locale)}
      </div>
    );
  }

  return (
    <div className="px-3 py-1">
      <div className="divider my-0 h-8 text-xs font-medium text-base-content/70 before:bg-info/40 after:bg-info/40">
        {item.row.message}
      </div>
      {item.unexpectedEnd ? (
        <p className="flex items-start justify-center gap-1.5 pb-1 text-center text-xs text-base-content/80">
          <TriangleAlert size={14} className="mt-px shrink-0 text-warning" aria-hidden="true" />
          {labels.unexpectedEnd}
        </p>
      ) : null}
    </div>
  );
}
