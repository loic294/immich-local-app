import { useEffect, useState, useCallback, useRef } from "react";
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
const CHECK_STALE_TIMEOUT = 2 * 60 * 1000; // 2 minutes

export function useSyncStatus(
  options: UseSyncStatusOptions = {},
): UseSyncStatusReturn {
  const { enableAutoCheck = true } = options;
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastStatusLogKeyRef = useRef<string>("");

  // Fetch sync status
  const fetchSyncStatus = useCallback(async () => {
    try {
      const status = await invoke<SyncStatus>("get_sync_status");
      const logKey = [
        status.isSyncing,
        status.checkStatus,
        status.totalAssets,
        status.processedAssets,
        status.lastCheckedAt,
        status.updatedAt,
      ].join("|");

      if (lastStatusLogKeyRef.current !== logKey) {
        console.info("[useSyncStatus] get_sync_status", {
          isSyncing: status.isSyncing,
          checkStatus: status.checkStatus,
          totalAssets: status.totalAssets,
          processedAssets: status.processedAssets,
          lastCheckedAt: status.lastCheckedAt,
          updatedAt: status.updatedAt,
        });
        lastStatusLogKeyRef.current = logKey;
      }

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
      console.info("[useSyncStatus] invoking check_for_new_assets", {
        previousTotal,
      });

      const result = await invoke<SyncStatus>("check_for_new_assets");
      console.info("[useSyncStatus] check_for_new_assets resolved", {
        returnedTotal: result.totalAssets,
        returnedCheckStatus: result.checkStatus,
      });

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

  // Poll for status updates while syncing or checking
  useEffect(() => {
    const updatedAtMs = syncStatus?.updatedAt
      ? new Date(syncStatus.updatedAt).getTime()
      : Number.NaN;
    const checkingAgeMs = Number.isFinite(updatedAtMs)
      ? Date.now() - updatedAtMs
      : Number.POSITIVE_INFINITY;
    const isFreshChecking =
      syncStatus?.checkStatus === "checking" &&
      checkingAgeMs >= 0 &&
      checkingAgeMs <= CHECK_STALE_TIMEOUT;
    const shouldPoll = Boolean(syncStatus?.isSyncing || isFreshChecking);

    if (!shouldPoll) {
      return;
    }

    const interval = setInterval(() => {
      void fetchSyncStatus();
    }, 1000); // Poll every 1 second

    return () => clearInterval(interval);
  }, [syncStatus?.isSyncing, syncStatus?.checkStatus, fetchSyncStatus]);

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

  const isChecking = (() => {
    if (syncStatus?.checkStatus !== "checking") {
      return false;
    }

    const updatedAtMs = syncStatus.updatedAt
      ? new Date(syncStatus.updatedAt).getTime()
      : Number.NaN;
    if (!Number.isFinite(updatedAtMs)) {
      return false;
    }

    const age = Date.now() - updatedAtMs;
    return age >= 0 && age <= CHECK_STALE_TIMEOUT;
  })();

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
