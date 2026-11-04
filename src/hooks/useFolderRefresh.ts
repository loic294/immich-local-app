import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { refreshFolderAssets } from "../api/tauri";
import { useConnectionContext } from "./connectionContext";

// Shares one backend refresh per folder so overlapping callers (remounts,
// StrictMode double effects) don't re-fetch the whole folder tree.
const inFlightRefreshes = new Map<string, Promise<number>>();

function refreshFolderOnce(path: string): Promise<number> {
  const existing = inFlightRefreshes.get(path);
  if (existing) {
    console.info("[phone_photos] joining in-flight folder refresh", { path });
    return existing;
  }
  const request = refreshFolderAssets(path).finally(() => inFlightRefreshes.delete(path));
  inFlightRefreshes.set(path, request);
  return request;
}

/**
 * Local-first lazy refresh for a single folder tree (the folder and all of its
 * subfolders). The caller renders from the local cache; this refreshes only
 * `path` from the server when the view opens, the connection returns, or
 * `refresh()` is called. It never triggers a library sync and never polls.
 * See sync.instructions.md.
 */
export function useFolderRefresh(path: string) {
  const queryClient = useQueryClient();
  const { isOnline } = useConnectionContext();
  const [requestNonce, setRequestNonce] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!path || isOnline !== true) {
      setIsRefreshing(false);
      return;
    }

    let cancelled = false;
    setIsRefreshing(true);
    console.info("[phone_photos] refreshing folder", { path, requestNonce });

    void (async () => {
      try {
        const count = await refreshFolderOnce(path);
        if (cancelled) return;
        console.info("[phone_photos] folder refreshed", { path, assets: count });
        await queryClient.invalidateQueries({ queryKey: ["folder-assets-paged", path] });
        // Reload the canvas grid layout from the updated cache.
        setRefreshNonce((nonce) => nonce + 1);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("offline:")) {
          console.info("[phone_photos] folder refresh skipped, server unreachable", { path });
        } else {
          console.warn("[phone_photos] folder refresh failed", { path, error: err });
          if (!cancelled) setError(message);
        }
      } finally {
        if (!cancelled) setIsRefreshing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, isOnline, requestNonce, queryClient]);

  const refresh = useCallback(() => setRequestNonce((nonce) => nonce + 1), []);

  return {
    isRefreshing,
    error,
    refreshNonce,
    refresh,
    canRefresh: Boolean(path) && isOnline === true,
  };
}
