import { Check, Copy, FolderOpen, Trash2, TriangleAlert } from "lucide-react";
import { useActivityLogLabels } from "../../i18n/activityLog";
import type { ActivityActionStatus } from "../../hooks/useActivityLogActions";

interface ActivityLogActionBarProps {
  shownCount: number;
  totalCount: number;
  status: ActivityActionStatus | null;
  canCopy: boolean;
  canOpenFolder: boolean;
  onCopy: () => void;
  onClear: () => void;
  onOpenFolder: () => void;
}

export function ActivityLogActionBar({
  shownCount,
  totalCount,
  status,
  canCopy,
  canOpenFolder,
  onCopy,
  onClear,
  onOpenFolder,
}: ActivityLogActionBarProps) {
  const labels = useActivityLogLabels();
  const failed = status !== null && status.kind !== "copied";
  const statusText =
    status === null
      ? ""
      : status.kind === "copied"
        ? labels.copied(status.count)
        : status.kind === "copy-failed"
          ? labels.copyFailed
          : labels.openLogFolderFailed;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="mr-auto text-xs tabular-nums text-base-content/70">
        {labels.counter(shownCount, totalCount)}
      </span>
      {/* Always rendered so assistive tech announces the text when it appears. */}
      <span role="status" aria-live="polite" className="flex items-center gap-1 text-xs">
        {status !== null ? (
          failed ? (
            <TriangleAlert size={14} className="text-error" aria-hidden="true" />
          ) : (
            <Check size={14} className="text-success" aria-hidden="true" />
          )
        ) : null}
        {statusText}
      </span>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={!canCopy}
        title={labels.copyTitle}
        onClick={onCopy}
      >
        <Copy size={14} aria-hidden="true" />
        {labels.copy}
      </button>
      <button type="button" className="btn btn-sm" disabled={!canOpenFolder} onClick={onOpenFolder}>
        <FolderOpen size={14} aria-hidden="true" />
        {labels.openLogFolder}
      </button>
      <button
        type="button"
        className="btn btn-outline btn-error btn-sm"
        title={labels.clearTitle}
        onClick={onClear}
      >
        <Trash2 size={14} aria-hidden="true" />
        {labels.clear}
      </button>
    </div>
  );
}
