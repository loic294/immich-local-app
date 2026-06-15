import { useState, useCallback } from "react";
import {
  DEFAULT_SORT_PREFERENCE,
  type SortDirection,
  type SortField,
  type SortPreference,
} from "../types";

const STORAGE_KEY = "sort_preference";

function loadSortPreference(): SortPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SORT_PREFERENCE;
    const parsed = JSON.parse(raw) as Partial<SortPreference>;
    const field: SortField =
      parsed.field === "date_captured" || parsed.field === "filename"
        ? parsed.field
        : DEFAULT_SORT_PREFERENCE.field;
    const direction: SortDirection =
      parsed.direction === "asc" || parsed.direction === "desc"
        ? parsed.direction
        : DEFAULT_SORT_PREFERENCE.direction;
    return { field, direction };
  } catch {
    return DEFAULT_SORT_PREFERENCE;
  }
}

function saveSortPreference(pref: SortPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // Ignore storage errors
  }
}

export type UseSortPreferenceReturn = {
  preference: SortPreference;
  setField: (field: SortField) => void;
  setDirection: (direction: SortDirection) => void;
};

/**
 * Global sort preference persisted in localStorage. All photo grid views share
 * the same preference; changing it in one view updates all others.
 */
export function useSortPreference(): UseSortPreferenceReturn {
  const [preference, setPreference] =
    useState<SortPreference>(loadSortPreference);

  const setField = useCallback((field: SortField) => {
    setPreference((current) => {
      const next = { ...current, field };
      saveSortPreference(next);
      console.log("[useSortPreference] field changed", { field });
      return next;
    });
  }, []);

  const setDirection = useCallback((direction: SortDirection) => {
    setPreference((current) => {
      const next = { ...current, direction };
      saveSortPreference(next);
      console.log("[useSortPreference] direction changed", { direction });
      return next;
    });
  }, []);

  return { preference, setField, setDirection };
}
