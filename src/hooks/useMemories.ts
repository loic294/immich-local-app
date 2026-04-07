import { useQuery } from "@tanstack/react-query";
import { fetchMemories } from "../api/tauri";

export function useMemories(enabled: boolean) {
  return useQuery({
    queryKey: ["memories"],
    enabled,
    queryFn: () => fetchMemories(),
    staleTime: 60_000,
  });
}
