import type { ReactNode } from "react";
import { useMonthYearPickerI18n } from "../../i18n/monthYearPicker";

interface MonthCaptionButtonProps {
  children?: ReactNode;
  onOpen: () => void;
}

/** Calendar caption ("November 2026") that opens the month/year quick picker. */
export function MonthCaptionButton({ children, onOpen }: MonthCaptionButtonProps) {
  const tp = useMonthYearPickerI18n();

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm font-medium"
      aria-label={tp("chooseMonthYear")}
      title={tp("chooseMonthYear")}
      onClick={onOpen}
    >
      {children}
    </button>
  );
}
