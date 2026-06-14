import { useQuery } from "@tanstack/react-query";
import { getCamerasInScope, getPeopleInScope } from "../api/tauri";
import type { PersonSummary, ViewScope } from "../types";

/**
 * Distinct camera names present in the assets of the given view scope. Used to
 * populate the Camera filter dropdown. Only runs while the filter bar is open
 * (`enabled`) to avoid unnecessary queries.
 */
export function useCameras(scope: ViewScope, enabled: boolean) {
  return useQuery({
    queryKey: ["cameras-in-scope", scope],
    enabled,
    queryFn: () => getCamerasInScope(scope),
    staleTime: 60_000,
  });
}

/**
 * People that appear in the assets of the given view scope. Used to populate
 * the People filter dropdown.
 */
export function usePeople(scope: ViewScope, enabled: boolean) {
  return useQuery<PersonSummary[]>({
    queryKey: ["people-in-scope", scope],
    enabled,
    queryFn: () => getPeopleInScope(scope),
    staleTime: 60_000,
  });
}
