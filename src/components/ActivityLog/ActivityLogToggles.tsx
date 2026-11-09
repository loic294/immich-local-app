import { useId } from "react";
import { useActivityLogLabels } from "../../i18n/activityLog";

interface ActivityLogTogglesProps {
  historyEnabled: boolean;
  historyLoading: boolean;
  onHistoryChange: (enabled: boolean) => void;
  verbose: boolean;
  onVerboseChange: (enabled: boolean) => void;
}

export function ActivityLogToggles({
  historyEnabled,
  historyLoading,
  onHistoryChange,
  verbose,
  onVerboseChange,
}: ActivityLogTogglesProps) {
  const labels = useActivityLogLabels();
  const verboseHintId = useId();

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
      <label
        className="flex cursor-pointer items-center gap-2 text-xs"
        title={labels.previousSessionsTitle}
      >
        <input
          type="checkbox"
          className="toggle toggle-sm"
          checked={historyEnabled}
          onChange={(event) => onHistoryChange(event.target.checked)}
        />
        {labels.previousSessions}
        {historyLoading ? (
          <span
            className="loading loading-spinner loading-xs"
            role="status"
            aria-label={labels.previousSessionsLoading}
          />
        ) : null}
      </label>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="toggle toggle-sm"
            checked={verbose}
            aria-describedby={verboseHintId}
            onChange={(event) => onVerboseChange(event.target.checked)}
          />
          {labels.verbose}
        </label>
        <span id={verboseHintId} className="text-xs text-base-content/70">
          {labels.verboseHint}
        </span>
      </div>
    </div>
  );
}
