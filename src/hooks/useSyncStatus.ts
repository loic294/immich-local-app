import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export type SyncStatus = {
  totalAssets: number;
  processedAssets: number;
  isSyncing: boolean;
  lastSyncCompletedAt: string | null;
  lastCheckedAt: string | null;
  checkStatus: string; // idle, checking, error
  createdAt: string;
  updatedAt: string;
};

export type UseSyncStatusReturn = {
  syncStatus: SyncStatus | null;
  isSyncing: boolean;
  isChecking: boolean;
  progress: number; // 0-100
  error: string | null;
  startSync: () => Promise<void>;
  forceFullSync: () => Promise<void>;
  checkForNewAssets: () => Promise<boolean>; // Returns true if new assets found
};

type UseSyncStatusOptions = {
  enableAutoCheck?: boolean;
};

const CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds

export function useSyncStatus(
  options: UseSyncStatusOptions = {},
): UseSyncStatusReturn {
  const { enableAutoCheck = true } = options;
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch sync status
  const fetchSyncStatus = useCallback(async () => {
    try {
      const status = await invoke<SyncStatus>("get_sync_status");
      setSyncStatus(status);
      setError(null);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Unknown error fetching sync status";
      setError(message);
    }
  }, []);

  // Start full sync
  const startSync = useCallback(async () => {
    try {
      setError(null);
      await invoke<SyncStatus>("start_asset_sync");
      // Fetch updated status
      await fetchSyncStatus();
    } catch (err) {
      let message = "Unknown error starting sync";
      if (err instanceof Error) {
        message = err.message;
      } else if (typeof err === "string") {
        message = err;
      } else if (typeof err === "object" && err !== null && "message" in err) {
        message = String((err as any).message);
      }
      console.error("Sync error:", err);
      setError(message);
    }
  }, [fetchSyncStatus]);

  const forceFullSync = useCallback(async () => {
    try {
      setError(null);
      console.info("[useSyncStatus] invoking force_full_asset_sync");
      await invoke<SyncStatus>("force_full_asset_sync");
      console.info(
        "[useSyncStatus] force_full_asset_sync invoked successfully",
      );
      await fetchSyncStatus();
    } catch (err) {
      let message = "Unknown error forcing full sync";
      if (err instanceof Error) {
        message = err.message;
      } else if (typeof err === "string") {
        message = err;
      } else if (typeof err === "object" && err !== null && "message" in err) {
        message = String((err as any).message);
      }
      console.error("Force full sync error:", err);
      setError(message);
    }
  }, [fetchSyncStatus]);

  // Check for new assets
  const checkForNewAssets = useCallback(async (): Promise<boolean> => {
    try {
      setError(null);
      const previousTotal = syncStatus?.totalAssets ?? 0;
      const result = await invoke<SyncStatus>("check_for_new_assets");
      // Fetch updated status
      await fetchSyncStatus();
      // Return true if new assets were found (total increased)
      return result.totalAssets > previousTotal;
    } catch (err) {
      let message = "Unknown error checking for new assets";
      if (err instanceof Error) {
        message = err.message;
      } else if (typeof err === "string") {
        message = err;
      } else if (typeof err === "object" && err !== null && "message" in err) {
        message = String((err as any).message);
      }
      console.error("Check error:", err);
      setError(message);
      return false;
    }
  }, [fetchSyncStatus, syncStatus?.totalAssets]);

  // Fetch initial status on mount
  useEffect(() => {
    void fetchSyncStatus();
  }, [fetchSyncStatus]);

  // Poll for status updates while syncing
  useEffect(() => {
    if (!syncStatus?.isSyncing) {
      return;
    }

    const interval = setInterval(() => {
      void fetchSyncStatus();
    }, 1000); // Poll every 1 second

    return () => clearInterval(interval);
  }, [syncStatus?.isSyncing, fetchSyncStatus]);

  // Set up periodic checks every 15 minutes
  useEffect(() => {
    if (!syncStatus || !enableAutoCheck) {
      return;
    }

    const checkTimer = setTimeout(() => {
      void checkForNewAssets();
    }, CHECK_INTERVAL);

    return () => clearTimeout(checkTimer);
  }, [enableAutoCheck, syncStatus?.lastCheckedAt, checkForNewAssets]);

  const progress =
    syncStatus && syncStatus.totalAssets > 0
      ? Math.round((syncStatus.processedAssets / syncStatus.totalAssets) * 100)
      : 0;

  const isChecking = syncStatus?.checkStatus === "checking";

  return {
    syncStatus,
    isSyncing: syncStatus?.isSyncing ?? false,
    isChecking,
    progress,
    error,
    startSync,
    forceFullSync,
    checkForNewAssets,
  };
}
