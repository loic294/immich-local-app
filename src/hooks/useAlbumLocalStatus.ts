import { useQuery } from "@tanstack/react-query";
import { getAlbumLocalStatus } from "../api/tauri";

export function useAlbumLocalStatus(albumId: string | null, folderPath: string | null) {
  return useQuery({
    queryKey: ["album-local-status", albumId, folderPath],
    queryFn: () => getAlbumLocalStatus(albumId!),
    enabled: Boolean(albumId && folderPath),
    staleTime: 0,
  });
}
