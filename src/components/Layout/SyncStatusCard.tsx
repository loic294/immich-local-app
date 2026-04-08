import { Check, RefreshCw } from "lucide-react";
import { useSyncStatus } from "../../hooks/useSyncStatus";

export function SyncStatusCard() {
  const {
    syncStatus,
    isSyncing,
    isChecking,
    progress,
    error,
    startSync,
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
    // First check for new assets
    const hasNewAssets = await checkForNewAssets();
    // If new assets found, run the full sync
    if (hasNewAssets) {
      await startSync();
    }
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
          {!isSyncing && !isChecking && "Sync Changes"}
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
