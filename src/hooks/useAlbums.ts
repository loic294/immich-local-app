import { useQuery } from "@tanstack/react-query";
import { fetchAlbums } from "../api/tauri";

export function useAlbums(enabled: boolean) {
  return useQuery({
    queryKey: ["albums"],
    enabled,
    queryFn: () => fetchAlbums(),
    staleTime: 60_000,
  });
}
