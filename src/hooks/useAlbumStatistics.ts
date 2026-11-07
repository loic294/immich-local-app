import { useQuery } from "@tanstack/react-query";
import { getAlbumStatistics } from "../api/tauri";

export const ALBUM_STATISTICS_QUERY_KEY = ["album-statistics"] as const;

/** Local-only album coverage stats; refetched whenever the card mounts. */
export function useAlbumStatistics() {
  return useQuery({
    queryKey: ALBUM_STATISTICS_QUERY_KEY,
    queryFn: async () => {
      try {
        return await getAlbumStatistics();
      } catch (error) {
        console.error("[album-stats] failed to load album statistics:", error);
        throw error;
      }
    },
    staleTime: 0,
  });
}
