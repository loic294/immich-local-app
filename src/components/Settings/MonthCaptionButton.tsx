import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
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
      className="btn btn-soft btn-sm relative z-10 gap-1 font-medium capitalize"
      aria-label={tp("chooseMonthYear")}
      title={tp("chooseMonthYear")}
      onClick={onOpen}
    >
      {children}
      <ChevronDown size={14} aria-hidden="true" />
    </button>
  );
}
