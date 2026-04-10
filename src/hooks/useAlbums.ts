import { useQuery } from "@tanstack/react-query";
import { getCachedAlbums } from "../api/tauri";

export function useAlbums(enabled: boolean) {
  return useQuery({
    queryKey: ["albums"],
    enabled,
    queryFn: () => getCachedAlbums(),
    staleTime: 60_000,
  });
}
