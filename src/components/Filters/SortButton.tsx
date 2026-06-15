import { ArrowDownAZ, ArrowUpAZ } from "lucide-react";
import type { SortDirection, SortField, SortPreference } from "../../types";
import { DEFAULT_SORT_PREFERENCE } from "../../types";

interface SortButtonProps {
  preference: SortPreference;
  onChange: (patch: Partial<SortPreference>) => void;
}

const FIELDS: { value: SortField; label: string }[] = [
  { value: "date_captured", label: "Date Captured" },
  { value: "filename", label: "Filename" },
];

const DIRECTIONS: { value: SortDirection; label: string }[] = [
  { value: "desc", label: "Descending" },
  { value: "asc", label: "Ascending" },
];

function isNonDefault(preference: SortPreference): boolean {
  return (
    preference.field !== DEFAULT_SORT_PREFERENCE.field ||
    preference.direction !== DEFAULT_SORT_PREFERENCE.direction
  );
}

export function SortButton({ preference, onChange }: SortButtonProps) {
  const active = isNonDefault(preference);
  const Icon = preference.direction === "asc" ? ArrowUpAZ : ArrowDownAZ;

  return (
    <details className="dropdown dropdown-end">
      <summary
        className={`btn btn-sm list-none ${active ? "btn-primary" : "btn-ghost"}`}
        aria-label="Sort photos"
      >
        <Icon size={14} className="shrink-0" />
        <span>Sort</span>
      </summary>

      <div className="dropdown-content z-20 mt-2 w-52 rounded-box border border-base-300 bg-base-100 p-2 shadow">
        <p className="px-2 py-1 text-xs font-semibold text-base-content/50 uppercase tracking-wide">
          Sort by
        </p>
        {FIELDS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={`btn btn-sm btn-ghost w-full justify-start ${preference.field === value ? "btn-active" : ""}`}
            onClick={() => onChange({ field: value })}
          >
            {label}
            {preference.field === value && (
              <span className="ml-auto text-primary">✓</span>
            )}
          </button>
        ))}

        <div className="divider my-1" />

        <p className="px-2 py-1 text-xs font-semibold text-base-content/50 uppercase tracking-wide">
          Order
        </p>
        {DIRECTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={`btn btn-sm btn-ghost w-full justify-start ${preference.direction === value ? "btn-active" : ""}`}
            onClick={() => onChange({ direction: value })}
          >
            {label}
            {preference.direction === value && (
              <span className="ml-auto text-primary">✓</span>
            )}
          </button>
        ))}
      </div>
    </details>
  );
}
