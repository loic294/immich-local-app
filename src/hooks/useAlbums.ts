import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCachedAlbums, refreshAlbumList } from "../api/tauri";
import { useConnectionContext } from "./connectionContext";

export function useAlbums(enabled: boolean) {
  const queryClient = useQueryClient();
  const { isOnline } = useConnectionContext();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["albums"],
    enabled,
    queryFn: () => getCachedAlbums(),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!enabled || isOnline !== true) {
      return;
    }
    let cancelled = false;
    setRefreshError(null);
    void refreshAlbumList()
      .then(async () => {
        if (!cancelled) {
          await queryClient.invalidateQueries({ queryKey: ["albums"] });
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[albums] album list refresh failed", err);
        if (!cancelled && !message.startsWith("offline:")) {
          setRefreshError(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, isOnline, queryClient]);

  return { ...query, refreshError };
}
