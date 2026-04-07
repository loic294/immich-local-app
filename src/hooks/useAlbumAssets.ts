import { useQuery } from "@tanstack/react-query";
import { fetchAlbumAssets } from "../api/tauri";

export function useAlbumAssets(enabled: boolean, albumId: string) {
  return useQuery({
    queryKey: ["album-assets", albumId],
    enabled,
    queryFn: () => fetchAlbumAssets(albumId),
    staleTime: 60_000,
  });
}
