import { useQuery } from "@tanstack/react-query";
import { getCachedUniqueOriginalPaths } from "../api/tauri";

export function useFolderPaths(enabled: boolean) {
  return useQuery({
    queryKey: ["folder-paths"],
    enabled,
    queryFn: () => getCachedUniqueOriginalPaths(),
    staleTime: 60_000,
  });
}
