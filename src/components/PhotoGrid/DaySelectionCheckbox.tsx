import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n";
import type { SectionSelectionState } from "./photoGridSelectionUtils";

interface DaySelectionCheckboxProps {
  /** Day separator label, used for the accessible name. */
  label: string;
  state: SectionSelectionState;
  onToggle: () => void;
}

/**
 * Always-visible tri-state checkbox for the photos under a day separator.
 * Checked when every photo under the separator is selected, indeterminate when
 * only some of them are.
 */
export function DaySelectionCheckbox({ label, state, onToggle }: DaySelectionCheckboxProps) {
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
      className="checkbox checkbox-sm checkbox-primary"
      checked={state === "all"}
      onChange={onToggle}
      aria-label={t(state === "all" ? "photoGrid.deselectDayAria" : "photoGrid.selectDayAria", {
        day: label,
      })}
    />
  );
}
