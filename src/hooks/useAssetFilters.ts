import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_FILTER_CRITERIA,
  criteriaPayload,
  isFilterActive,
  type AssetFilterCriteria,
} from "../types";

export type UseAssetFiltersReturn = {
  /** Current, locally-edited filter selections. */
  criteria: AssetFilterCriteria;
  /** Collapsed payload to send to the backend (null when nothing is active). */
  payload: AssetFilterCriteria | null;
  /** True when at least one filter dimension narrows the result set. */
  isActive: boolean;
  /** Whether the filter bar is currently expanded. */
  isOpen: boolean;
  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  /** Merge a partial update into the current criteria. */
  update: (patch: Partial<AssetFilterCriteria>) => void;
  /** Reset every dimension back to its default (unfiltered) value. */
  reset: () => void;
};

/**
 * Owns the filter state for a single photo grid view. Filters automatically
 * reset whenever the view changes (new page, album, folder or month) so a
 * narrow selection never silently carries over to an unrelated set of photos.
 *
 * @param scopeKey A stable string identifying the current view. When it
 *   changes, the criteria and open state are reset.
 */
export function useAssetFilters(scopeKey: string): UseAssetFiltersReturn {
  const [criteria, setCriteria] = useState<AssetFilterCriteria>(
    DEFAULT_FILTER_CRITERIA,
  );
  const [isOpen, setIsOpen] = useState(false);
  const previousScopeRef = useRef(scopeKey);

  useEffect(() => {
    if (previousScopeRef.current === scopeKey) {
      return;
    }
    previousScopeRef.current = scopeKey;
    console.log("[useAssetFilters] scope changed, resetting filters", {
      scopeKey,
    });
    setCriteria(DEFAULT_FILTER_CRITERIA);
    setIsOpen(false);
  }, [scopeKey]);

  const update = useCallback((patch: Partial<AssetFilterCriteria>) => {
    setCriteria((current) => ({ ...current, ...patch }));
  }, []);

  const reset = useCallback(() => {
    setCriteria(DEFAULT_FILTER_CRITERIA);
  }, []);

  const toggleOpen = useCallback(() => {
    setIsOpen((current) => !current);
  }, []);

  const setOpen = useCallback((open: boolean) => {
    setIsOpen(open);
  }, []);

  const payload = useMemo(() => criteriaPayload(criteria), [criteria]);
  const isActive = useMemo(() => isFilterActive(criteria), [criteria]);

  return {
    criteria,
    payload,
    isActive,
    isOpen,
    toggleOpen,
    setOpen,
    update,
    reset,
  };
}
