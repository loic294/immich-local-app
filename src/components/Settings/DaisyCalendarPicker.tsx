import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { DayPicker } from "react-day-picker";

interface DaisyCalendarPickerProps {
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Date picker using daisyUI's supported React Day Picker calendar styling.
 */
export function DaisyCalendarPicker({
  value,
  onChange,
  disabled = false,
}: DaisyCalendarPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = parseDateOnly(value);

  return (
    <details
      className="dropdown w-full"
      open={open && !disabled}
      onToggle={(event) => {
        if (disabled) {
          setOpen(false);
          return;
        }
        setOpen((event.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary
        className={`btn btn-sm w-full justify-between ${disabled ? "btn-disabled" : "btn-outline"}`}
      >
        <span className="truncate">{value ?? "Select date"}</span>
        <CalendarDays size={16} />
      </summary>

      <div className="dropdown-content z-30 mt-2 rounded-box border border-base-300 bg-base-100 p-2 shadow">
        <DayPicker
          mode="single"
          className="react-day-picker"
          selected={selected}
          onSelect={(date) => {
            if (!date) {
              return;
            }
            onChange(toDateOnly(date));
            setOpen(false);
          }}
        />
      </div>
    </details>
  );
}

function parseDateOnly(value: string | null): Date | undefined {
  if (!value) {
    return undefined;
  }
  const [year, month, day] = value
    .split("-")
    .map((part) => Number.parseInt(part, 10));
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
