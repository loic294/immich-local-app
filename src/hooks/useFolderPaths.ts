import { useQuery } from "@tanstack/react-query";
import { fetchUniqueOriginalPaths } from "../api/tauri";

export function useFolderPaths(enabled: boolean) {
  return useQuery({
    queryKey: ["folder-paths"],
    enabled,
    queryFn: () => fetchUniqueOriginalPaths(),
    staleTime: 60_000,
  });
}
