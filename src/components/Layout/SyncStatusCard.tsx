import { Check, RefreshCw } from "lucide-react";
import { useSyncStatus } from "../../hooks/useSyncStatus";

export function SyncStatusCard() {
  const {
    syncStatus,
    isSyncing,
    isChecking,
    progress,
    error,
    checkForNewAssets,
  } = useSyncStatus();

  const isBusy = isSyncing || isChecking;
  const isSyncComplete =
    syncStatus?.lastSyncCompletedAt !== null &&
    syncStatus?.lastSyncCompletedAt !== undefined;

  const formatDate = (dateString: string | null): string => {
    if (!dateString) return "";
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateString;
    }
  };

  const handleAction = async () => {
    // Quick sync only: check for and pull in recent new assets. A full library
    // re-scan is available from Settings ("Force Full Sync").
    await checkForNewAssets();
  };

  return (
    <div className="card card-compact bg-base-200 shadow">
      <div className="card-body p-3 gap-3">
        {isSyncing && syncStatus ? (
          <>
            <progress
              className="progress progress-primary progress-sm"
              value={progress}
              max="100"
            ></progress>
            <div className="text-xs text-base-content/70">
              {syncStatus.processedAssets} / {syncStatus.totalAssets} photos
              synced
            </div>
          </>
        ) : isChecking ? (
          <>
            <div className="flex items-center gap-2">
              <span className="loading loading-spinner loading-xs"></span>
              <span className="text-xs text-base-content/70">
                Checking for new assets...
              </span>
            </div>
          </>
        ) : isSyncComplete && syncStatus ? (
          <>
            <div
              className="tooltip tooltip-top w-full"
              data-tip={formatDate(syncStatus.lastCheckedAt)}
            >
              <div className="flex items-center gap-2">
                <Check size={16} className="text-success" />
                <span className="text-xs font-medium text-success">
                  Sync Complete
                </span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="text-xs text-base-content/70">
              Ready to sync photos
            </div>
          </>
        )}

        <button
          className="btn btn-sm btn-soft w-full"
          onClick={() => void handleAction()}
          disabled={isBusy}
        >
          {isSyncing && "Syncing..."}
          {isChecking && "Checking..."}
          {!isSyncing && !isChecking && "Check for New Photos"}
        </button>

        {error && (
          <div className="alert alert-error alert-sm">
            <span className="text-xs">{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
