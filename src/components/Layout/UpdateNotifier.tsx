import { useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import type { UseAppUpdateResult } from "../../hooks/useAppUpdate";

interface UpdateNotifierProps {
  update: UseAppUpdateResult;
}

/**
 * Unobtrusive toast shown across authenticated pages when an update has been
 * downloaded and is ready to install. The download itself happens silently in
 * the background (see App startup check).
 */
export function UpdateNotifier({ update }: UpdateNotifierProps) {
  const [dismissed, setDismissed] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);

  const showDownloading = update.status === "downloading";
  const showReady = update.status === "ready" && !dismissed;

  if (!showDownloading && !showReady) {
    return null;
  }

  return (
    <div className="toast toast-end toast-bottom z-50">
      {showDownloading ? (
        <div className="alert border border-base-300 bg-base-200 text-base-content shadow-lg">
          <Download size={18} className="shrink-0 text-primary" />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Downloading update…</span>
            <progress
              className="progress progress-primary w-48"
              value={update.progress ?? 0}
              max="100"
            ></progress>
          </div>
        </div>
      ) : (
        <div className="alert border border-base-300 bg-base-200 text-base-content shadow-lg">
          <RefreshCw size={18} className="shrink-0 text-primary" />
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              Update {update.newVersion} is ready
            </span>
            <span className="text-xs text-base-content/60">
              Restart to finish installing.
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={isInstalling}
              onClick={() => {
                setIsInstalling(true);
                void update.installAndRelaunch().finally(() => {
                  setIsInstalling(false);
                });
              }}
            >
              {isInstalling ? "Restarting…" : "Restart now"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square"
              aria-label="Dismiss update notification"
              disabled={isInstalling}
              onClick={() => setDismissed(true)}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
