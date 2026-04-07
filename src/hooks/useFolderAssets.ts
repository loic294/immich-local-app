import { useQuery } from "@tanstack/react-query";
import { fetchAssetsByOriginalPath } from "../api/tauri";

export function useFolderAssets(enabled: boolean, path: string) {
  return useQuery({
    queryKey: ["folder-assets", path],
    enabled,
    queryFn: () => fetchAssetsByOriginalPath(path),
    staleTime: 30_000,
  });
}
