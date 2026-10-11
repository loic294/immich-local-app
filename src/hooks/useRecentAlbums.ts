import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRecentAlbums } from "../api/tauri";

export function useRecentAlbums(limit: number) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["recent-albums", limit],
    queryFn: () => getRecentAlbums(limit),
    enabled: limit > 0,
    staleTime: 0,
  });

  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["recent-albums"] });
    };
    window.addEventListener("recent-albums-changed", refresh);
    return () => window.removeEventListener("recent-albums-changed", refresh);
  }, [queryClient]);

  return query;
}
