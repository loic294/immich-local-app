import { useShortcutHandlers } from "../../shortcuts/useShortcutHandler";
import type { SortPreference } from "../../types";

interface TopBarShortcutOptions {
  selectedCount: number;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
  /** Opens the delete confirmation for the selection; leave undefined when the view cannot delete. */
  onRequestDelete?: () => void;
  /** Leave undefined on views without a filter bar. */
  onToggleFilter?: () => void;
  /** Leave undefined on views without sorting. */
  sortPreference?: SortPreference;
  onSortChange?: (patch: Partial<SortPreference>) => void;
}

/** Registers the shortcuts for the selection toolbar, filter and sort controls of the top bar. */
export function useTopBarShortcuts({
  selectedCount,
  onSelectAll,
  onClearSelection,
  onRequestDelete,
  onToggleFilter,
  sortPreference,
  onSortChange,
}: TopBarShortcutOptions): void {
  const hasSelection = selectedCount > 0;
  const canSort = sortPreference !== undefined && onSortChange !== undefined;

  useShortcutHandlers({
    "selection.selectAll": onSelectAll,
    "selection.clear": hasSelection ? onClearSelection : undefined,
    "photo.delete": hasSelection ? onRequestDelete : undefined,
    "view.toggleFilter": onToggleFilter,
    "view.sortField": canSort
      ? () =>
          onSortChange({
            field: sortPreference.field === "filename" ? "date_captured" : "filename",
          })
      : undefined,
    "view.sortDirection": canSort
      ? () => onSortChange({ direction: sortPreference.direction === "asc" ? "desc" : "asc" })
      : undefined,
  });
}
