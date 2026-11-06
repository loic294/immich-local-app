import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n";
import type { SectionSelectionState } from "./photoGridSelectionUtils";

interface DaySelectionCheckboxProps {
  /** Day separator label, used for the accessible name. */
  label: string;
  state: SectionSelectionState;
  isSelecting: boolean;
  onToggle: () => void;
}

/**
 * Tri-state checkbox revealed on day-name hover or keyboard focus, and kept
 * visible while photos are selected.
 * Checked when every photo under the separator is selected, indeterminate when
 * only some of them are.
 */
export function DaySelectionCheckbox({
  label,
  state,
  isSelecting,
  onToggle,
}: DaySelectionCheckboxProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  // The browser clears `indeterminate` when the box is clicked, so re-apply it after every render.
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = state === "some";
    }
  });

  return (
    <input
      ref={inputRef}
      type="checkbox"
      className={`checkbox checkbox-sm checkbox-primary ${
        isSelecting ? "opacity-100" : "opacity-0 group-hover/day:opacity-100 focus:opacity-100"
      }`}
      checked={state === "all"}
      onChange={onToggle}
      aria-label={t(state === "all" ? "photoGrid.deselectDayAria" : "photoGrid.selectDayAria", {
        day: label,
      })}
    />
  );
}
