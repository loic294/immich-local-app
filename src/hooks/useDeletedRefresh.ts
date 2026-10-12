import { useEffect, useState } from "react";
import { ASSET_DELETION_CHANGED_EVENT, refreshDeletedAssets } from "../api/deletion";
import type { AssetFilter } from "../types";

/** Opening Deleted refreshes only its selected dataset, never the library. */
export function useDeletedRefresh(filter: AssetFilter) {
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const changed = () => setNonce((value) => value + 1);
    window.addEventListener(ASSET_DELETION_CHANGED_EVENT, changed);
    window.addEventListener("media:versions-changed", changed);
    return () => {
      window.removeEventListener(ASSET_DELETION_CHANGED_EVENT, changed);
      window.removeEventListener("media:versions-changed", changed);
    };
  }, []);
  useEffect(() => {
    if (filter !== "archived" && filter !== "trashed") return;
    let cancelled = false;
    setError(null);
    void refreshDeletedAssets(filter === "trashed" ? "trash" : "archive")
      .catch((reason: unknown) => {
        console.warn("[assets.deleted-refresh]", reason);
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setNonce((value) => value + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);
  return { nonce, error };
}
