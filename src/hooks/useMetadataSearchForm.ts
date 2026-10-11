import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCamerasInScope, getPeopleInScope } from "../api/tauri";
import type { ViewScope } from "../types";
import type { MetadataSearchForm } from "../types/search";
import {
  EMPTY_METADATA_SEARCH,
  buildMetadataQuery,
  parseMetadataQuery,
} from "../utils/metadataQuery";

const ALL_SCOPE: ViewScope = { kind: "all" };

/** Structured search form state, seeded from the current raw query when opened. */
export function useMetadataSearchForm(query: string) {
  const [form, setForm] = useState<MetadataSearchForm>(() => parseMetadataQuery(query));
  const reset = useCallback(() => setForm(parseMetadataQuery(query)), [query]);
  const clear = useCallback(() => setForm({ ...EMPTY_METADATA_SEARCH }), []);
  const update = useCallback(
    <K extends keyof MetadataSearchForm>(key: K, value: MetadataSearchForm[K]) =>
      setForm((current) => ({ ...current, [key]: value })),
    [],
  );
  return { form, update, reset, clear, query: buildMetadataQuery(form) };
}

/** Cached (local SQLite) suggestions for people and cameras. */
export function useMetadataSuggestions(enabled: boolean, scope: ViewScope = ALL_SCOPE) {
  const people = useQuery({
    queryKey: ["people-in-scope", "metadata-search", scope],
    queryFn: () => getPeopleInScope(scope),
    enabled,
    staleTime: 60_000,
  });
  const cameras = useQuery({
    queryKey: ["cameras-in-scope", "metadata-search", scope],
    queryFn: () => getCamerasInScope(scope),
    enabled,
    staleTime: 60_000,
  });
  return {
    people: (people.data ?? [])
      .filter((person) => !person.isHidden && person.name)
      .map((person) => person.name as string),
    cameras: cameras.data ?? [],
  };
}
