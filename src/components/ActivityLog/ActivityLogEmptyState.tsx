import { ScrollText, SearchX } from "lucide-react";
import { useActivityLogLabels } from "../../i18n/activityLog";

interface ActivityLogEmptyStateProps {
  /** "empty": nothing has been logged; "no-match": entries exist but the filters hide them all. */
  variant: "empty" | "no-match";
  onResetFilters: () => void;
}

export function ActivityLogEmptyState({ variant, onResetFilters }: ActivityLogEmptyStateProps) {
  const labels = useActivityLogLabels();
  const noMatch = variant === "no-match";
  const Icon = noMatch ? SearchX : ScrollText;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <Icon size={32} className="text-base-content/50" aria-hidden="true" />
      <p className="text-sm font-medium">{noMatch ? labels.noMatchTitle : labels.emptyTitle}</p>
      <p className="max-w-sm text-sm text-base-content/70">
        {noMatch ? labels.noMatchBody : labels.emptyBody}
      </p>
      {noMatch ? (
        <button type="button" className="btn btn-sm mt-2" onClick={onResetFilters}>
          {labels.resetFilters}
        </button>
      ) : null}
    </div>
  );
}
