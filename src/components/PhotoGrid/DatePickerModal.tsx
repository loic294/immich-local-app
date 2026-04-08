import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type DatePickerModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelectDate: (dateKey: string) => void;
  availableDates: string[];
};

export function DatePickerModal({
  isOpen,
  onClose,
  onSelectDate,
  availableDates,
}: DatePickerModalProps) {
  const initialDate = useMemo(() => {
    const fallback = new Date();
    const firstAvailableDate = availableDates[0];
    if (!firstAvailableDate) {
      return fallback;
    }

    const [year, month, day] = firstAvailableDate.split("-").map(Number);
    return new Date(year, month - 1, day);
  }, [availableDates]);

  const [selectedYear, setSelectedYear] = useState(initialDate.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(
    initialDate.getMonth() + 1,
  );

  useEffect(() => {
    setSelectedYear(initialDate.getFullYear());
    setSelectedMonth(initialDate.getMonth() + 1);
  }, [initialDate, isOpen]);

  if (!isOpen) {
    return null;
  }

  // Get all available dates for the selected month
  const availableInMonth = availableDates
    .filter((dateStr) => {
      const [year, month] = dateStr.split("-").map(Number);
      return year === selectedYear && month === selectedMonth;
    })
    .sort()
    .reverse(); // Most recent first

  // Extract unique years from available dates
  const availableYears = Array.from(
    new Set(
      availableDates.map((dateStr) => parseInt(dateStr.split("-")[0], 10)),
    ),
  ).sort((a, b) => b - a); // Newest first

  // For selected year, get available months
  const availableMonths = Array.from(
    new Set(
      availableDates
        .filter((dateStr) => dateStr.startsWith(`${selectedYear}-`))
        .map((dateStr) => parseInt(dateStr.split("-")[1], 10)),
    ),
  ).sort((a, b) => b - a); // Newest first

  const handleDateClick = (dateStr: string) => {
    onSelectDate(dateStr);
    onClose();
  };

  const monthName = new Date(selectedYear, selectedMonth - 1).toLocaleString(
    "default",
    { month: "long" },
  );

  return (
    <div
      className="fixed inset-0 z-10000 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to date"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border border-base-300 bg-base-100 p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="btn btn-circle btn-ghost btn-sm absolute right-4 top-4"
          onClick={onClose}
          aria-label="Close date picker"
        >
          <X size={20} />
        </button>

        <h2 className="mb-4 text-lg font-semibold">Jump to Date</h2>

        <div className="space-y-4">
          <div>
            <label className="label text-sm font-medium">Year</label>
            <select
              value={selectedYear}
              onChange={(e) => {
                const newYear = parseInt(e.target.value, 10);
                setSelectedYear(newYear);
                const availableMonthsForYear = Array.from(
                  new Set(
                    availableDates
                      .filter((dateStr) => dateStr.startsWith(`${newYear}-`))
                      .map((dateStr) => parseInt(dateStr.split("-")[1], 10)),
                  ),
                ).sort((a, b) => b - a);
                if (availableMonthsForYear.length > 0) {
                  setSelectedMonth(availableMonthsForYear[0]);
                }
              }}
              className="select select-bordered w-full"
            >
              {availableYears.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label text-sm font-medium">Month</label>
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(parseInt(e.target.value, 10))}
              className="select select-bordered w-full"
            >
              {availableMonths.map((month) => (
                <option key={month} value={month}>
                  {new Date(selectedYear, month - 1).toLocaleString("default", {
                    month: "long",
                  })}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label text-sm font-medium">
              {monthName} {selectedYear}
            </label>
            {availableInMonth.length > 0 ? (
              <div className="grid grid-cols-7 gap-2">
                {availableInMonth.map((dateStr) => {
                  const day = parseInt(dateStr.split("-")[2], 10);
                  return (
                    <button
                      key={dateStr}
                      onClick={() => handleDateClick(dateStr)}
                      className="btn btn-sm btn-outline"
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-base-content/60">
                No photos available for this month
              </p>
            )}
          </div>
        </div>

        <div className="modal-action mt-6">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
