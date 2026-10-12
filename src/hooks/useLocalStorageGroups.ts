import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getLocalStorageGroups,
  prepareLocalStorageRemoval,
  removeLocalStorageGroup,
} from "../api/storage";

export function useLocalStorageGroups() {
  const client = useQueryClient();
  const groups = useQuery({
    queryKey: ["local-storage-groups"],
    queryFn: getLocalStorageGroups,
    staleTime: 0,
  });
  const prepare = useMutation({ mutationFn: prepareLocalStorageRemoval });
  const remove = useMutation({
    mutationFn: removeLocalStorageGroup,
    onSettled: async () => {
      await Promise.all(
        ["local-storage-groups", "storage-summary", "albums", "album-local-status", "assets"].map(
          (key) => client.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
  return { groups, prepare, remove };
}
