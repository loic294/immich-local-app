import { useEffect, useMemo, useState } from "react";
import { getAssetThumbnail } from "../../api/tauri";
import type { SavedLocalFileChange } from "../../types";

type LocalSavedFileChangesModalProps = {
  open: boolean;
  changes: SavedLocalFileChange[];
  isApplying: boolean;
  applyErrors: string[];
  onApplyAll: () => Promise<void>;
  onApplySelected: (changeIds: number[]) => Promise<void>;
  onCancel: () => void;
};

function formatDetectedChanges(detailsJson: string): string[] {
  try {
    const value = JSON.parse(detailsJson) as {
      message?: string;
      previousMtimeMs?: number | null;
      currentMtimeMs?: number | null;
      previousSizeBytes?: number | null;
      currentSizeBytes?: number | null;
    };

    const lines: string[] = [];
    if (value.message) {
      lines.push(value.message);
    }

    if (
      value.previousSizeBytes != null &&
      value.currentSizeBytes != null &&
      value.previousSizeBytes !== value.currentSizeBytes
    ) {
      lines.push(
        `Size: ${value.previousSizeBytes} B -> ${value.currentSizeBytes} B`,
      );
    }

    if (
      value.previousMtimeMs != null &&
      value.currentMtimeMs != null &&
      value.previousMtimeMs !== value.currentMtimeMs
    ) {
      const oldDate = new Date(value.previousMtimeMs).toLocaleString();
      const newDate = new Date(value.currentMtimeMs).toLocaleString();
      lines.push(`Modified: ${oldDate} -> ${newDate}`);
    }

    return lines.length > 0 ? lines : ["Detected local file change."];
  } catch {
    return ["Detected local file change."];
  }
}

export function LocalSavedFileChangesModal({
  open,
  changes,
  isApplying,
  applyErrors,
  onApplyAll,
  onApplySelected,
  onCancel,
}: LocalSavedFileChangesModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) {
      setSelectedIds(new Set());
      return;
    }

    setSelectedIds(new Set(changes.map((item) => item.id)));
  }, [open, changes]);

  useEffect(() => {
    if (!open || changes.length === 0) {
      return;
    }

    let cancelled = false;
    const uniqueAssetIds = Array.from(
      new Set(changes.map((item) => item.assetId)),
    );

    void (async () => {
      const next: Record<string, string> = {};
      for (const assetId of uniqueAssetIds) {
        try {
          const thumbnail = await getAssetThumbnail(assetId);
          next[assetId] = thumbnail;
        } catch {
          continue;
        }
      }

      if (!cancelled) {
        setThumbnails(next);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, changes]);

  const selectedCount = selectedIds.size;

  const grouped = useMemo(() => changes, [changes]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal modal-open" role="dialog" aria-modal="true">
      <div className="modal-box w-11/12 max-w-5xl p-0">
        <div className="border-b border-base-300 px-6 py-4">
          <h3 className="text-lg font-semibold">Local File Changes Detected</h3>
          <p className="mt-1 text-sm text-base-content/70">
            Review deleted or modified local files and choose which changes to
            apply.
          </p>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          {applyErrors.length > 0 ? (
            <div role="alert" className="alert alert-error alert-soft mb-3 text-sm">
              <div className="space-y-1">
                <p className="font-semibold">
                  Some changes could not be applied on the server.
                </p>
                {applyErrors.slice(0, 3).map((error, index) => (
                  <p key={`${index}-${error}`}>{error}</p>
                ))}
                {applyErrors.length > 3 ? (
                  <p>...and {applyErrors.length - 3} more errors.</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {grouped.length === 0 ? (
            <p className="px-2 py-6 text-sm text-base-content/70">
              No pending local file changes.
            </p>
          ) : (
            <ul className="space-y-2">
              {grouped.map((change) => {
                const details = formatDetectedChanges(change.detailsJson);
                const isDeletedLocally = change.changeKind === "deleted";
                const visibleDetails = isDeletedLocally
                  ? details.filter((line) => line !== "File deleted locally")
                  : details;
                const checked = selectedIds.has(change.id);
                const thumbnail = thumbnails[change.assetId];

                return (
                  <li
                    key={change.id}
                    className="rounded-lg border border-base-300 bg-base-100 p-3"
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm mt-1"
                        checked={checked}
                        onChange={(event) => {
                          const next = new Set(selectedIds);
                          if (event.currentTarget.checked) {
                            next.add(change.id);
                          } else {
                            next.delete(change.id);
                          }
                          setSelectedIds(next);
                        }}
                        disabled={isApplying}
                      />

                      <div className="avatar">
                        <div className="h-16 w-16 rounded-lg bg-base-200">
                          {thumbnail ? (
                            <img
                              src={thumbnail}
                              alt={change.fileName}
                              className="object-cover"
                            />
                          ) : null}
                        </div>
                      </div>

                      <div className="min-w-0 flex-1">
                        {isDeletedLocally ? (
                          <span className="badge badge-error badge-soft mb-1">
                            File deleted locally
                          </span>
                        ) : null}
                        <p className="truncate text-sm font-semibold">
                          {change.fileName}
                        </p>
                        <p className="truncate text-xs text-base-content/60">
                          {change.localPath}
                        </p>
                        <ul className="mt-2 space-y-1 text-xs text-base-content/80">
                          {visibleDetails.map((line) => (
                            <li key={`${change.id}-${line}`}>• {line}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="modal-action mt-0 border-t border-base-300 px-6 py-4">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={isApplying}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => {
              void onApplySelected(Array.from(selectedIds));
            }}
            disabled={isApplying || selectedCount === 0}
          >
            {isApplying ? "Applying..." : `Apply Selected (${selectedCount})`}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void onApplyAll();
            }}
            disabled={isApplying || grouped.length === 0}
          >
            {isApplying ? "Applying..." : "Apply All Changes"}
          </button>
        </div>
      </div>
      <button
        className="modal-backdrop"
        onClick={onCancel}
        aria-label="Close"
      />
    </div>
  );
}
