import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "../../i18n";
import { useMonthYearPickerI18n } from "../../i18n/monthYearPicker";
import {
  YEARS_PER_PAGE,
  clampYear,
  shiftYearPage,
  yearPageStart,
  yearsOnPage,
} from "../../utils/monthYearPicker";

interface MonthYearQuickPickerProps {
  /** Month currently displayed by the calendar. */
  month: Date;
  onSelect: (month: Date) => void;
  onCancel: () => void;
}

type PickerStep = "month" | "year";

/**
 * Month grid with a clickable year header that opens a paged year grid,
 * so any year and month is reachable in a few clicks.
 */
export function MonthYearQuickPicker({ month, onSelect, onCancel }: MonthYearQuickPickerProps) {
  const { locale } = useI18n();
  const tp = useMonthYearPickerI18n();
  const [step, setStep] = useState<PickerStep>("month");
  const [year, setYear] = useState(() => clampYear(month.getFullYear()));
  const [pageStart, setPageStart] = useState(() => yearPageStart(month.getFullYear()));

  const monthLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { month: "short" });
    return Array.from({ length: 12 }, (_, index) => formatter.format(new Date(2000, index, 1)));
  }, [locale]);

  const inYearStep = step === "year";
  const pageEnd = pageStart + YEARS_PER_PAGE - 1;

  return (
    <div
      className="flex w-[calc(16.75rem+2px)] flex-col gap-2 rounded-box border border-base-200 bg-base-100 p-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square"
          aria-label={inYearStep ? tp("previousYears") : tp("previousYear")}
          onClick={() =>
            inYearStep
              ? setPageStart((current) => shiftYearPage(current, -1))
              : setYear((current) => clampYear(current - 1))
          }
        >
          <ChevronLeft size={16} />
        </button>

        {inYearStep ? (
          <span className="text-sm font-medium">{`${pageStart} – ${pageEnd}`}</span>
        ) : (
          <button
            type="button"
            className="btn btn-soft btn-sm gap-1 font-medium"
            aria-label={tp("chooseYear")}
            title={tp("chooseYear")}
            onClick={() => {
              setPageStart(yearPageStart(year));
              setStep("year");
            }}
          >
            {year}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square"
          aria-label={inYearStep ? tp("nextYears") : tp("nextYear")}
          onClick={() =>
            inYearStep
              ? setPageStart((current) => shiftYearPage(current, 1))
              : setYear((current) => clampYear(current + 1))
          }
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1">
        {inYearStep
          ? yearsOnPage(pageStart).map((candidate) => {
              const isCurrent = candidate === month.getFullYear();
              return (
                <button
                  key={candidate}
                  type="button"
                  className={`btn btn-sm ${isCurrent ? "btn-primary" : "btn-ghost"}`}
                  aria-pressed={isCurrent}
                  autoFocus={isCurrent}
                  onClick={() => {
                    setYear(candidate);
                    setStep("month");
                  }}
                >
                  {candidate}
                </button>
              );
            })
          : monthLabels.map((label, index) => {
              const isCurrent = year === month.getFullYear() && index === month.getMonth();
              return (
                <button
                  key={index}
                  type="button"
                  className={`btn btn-sm capitalize ${isCurrent ? "btn-primary" : "btn-ghost"}`}
                  aria-pressed={isCurrent}
                  autoFocus={isCurrent}
                  onClick={() => onSelect(new Date(year, index, 1))}
                >
                  {label}
                </button>
              );
            })}
      </div>

      <button type="button" className="btn btn-ghost btn-xs self-center" onClick={onCancel}>
        {tp("backToCalendar")}
      </button>
    </div>
  );
}
