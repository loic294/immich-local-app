import { useCallback, useMemo, useState, type ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { enCA } from "react-day-picker/locale/en-CA";
import { frCA } from "react-day-picker/locale/fr-CA";
import { useI18n } from "../../i18n";
import { MonthCaptionButton } from "./MonthCaptionButton";
import { MonthYearQuickPicker } from "./MonthYearQuickPicker";

interface DaisyCalendarPickerProps {
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Date picker using daisyUI's supported React Day Picker calendar styling.
 * Clicking the month/year caption opens a quick year and month picker.
 */
export function DaisyCalendarPicker({
  value,
  onChange,
  disabled = false,
}: DaisyCalendarPickerProps) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<Date>(() => parseDateOnly(value) ?? new Date());
  const [quickPickerOpen, setQuickPickerOpen] = useState(false);
  const selected = parseDateOnly(value);

  const openQuickPicker = useCallback(() => setQuickPickerOpen(true), []);
  const components = useMemo(
    () => ({
      CaptionLabel: (captionProps: { children?: ReactNode }) => (
        <MonthCaptionButton onOpen={openQuickPicker}>{captionProps.children}</MonthCaptionButton>
      ),
    }),
    [openQuickPicker],
  );

  return (
    <details
      className="dropdown w-full"
      open={open && !disabled}
      onToggle={(event) => {
        if (disabled) {
          setOpen(false);
          return;
        }
        const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
        if (nextOpen && !open) {
          setMonth(selected ?? new Date());
          setQuickPickerOpen(false);
        }
        setOpen(nextOpen);
      }}
    >
      <summary
        className={`btn btn-sm w-full justify-between ${disabled ? "btn-disabled" : "btn-outline"}`}
      >
        <span className="truncate">{value ?? t("settings.selectDate")}</span>
        <CalendarDays size={16} />
      </summary>

      <div className="dropdown-content z-30 mt-2 rounded-box border border-base-300 bg-base-100 p-2 shadow">
        {quickPickerOpen ? (
          <MonthYearQuickPicker
            month={month}
            onSelect={(nextMonth) => {
              setMonth(nextMonth);
              setQuickPickerOpen(false);
            }}
            onCancel={() => setQuickPickerOpen(false)}
          />
        ) : (
          <DayPicker
            mode="single"
            className="react-day-picker"
            locale={locale === "fr-CA" ? frCA : enCA}
            components={components}
            month={month}
            onMonthChange={setMonth}
            selected={selected}
            onSelect={(date) => {
              if (!date) {
                return;
              }
              onChange(toDateOnly(date));
              setOpen(false);
            }}
          />
        )}
      </div>
    </details>
  );
}

function parseDateOnly(value: string | null): Date | undefined {
  if (!value) {
    return undefined;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) {
    return undefined;
  }
  return new Date(year, month - 1, day);
}

function toDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
