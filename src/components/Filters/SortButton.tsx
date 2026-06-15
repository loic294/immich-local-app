import { ArrowDownAZ, ArrowUpAZ } from "lucide-react";
import type { SortDirection, SortField, SortPreference } from "../../types";
import { DEFAULT_SORT_PREFERENCE } from "../../types";
import { useI18n } from "../../i18n";

interface SortButtonProps {
  preference: SortPreference;
  onChange: (patch: Partial<SortPreference>) => void;
}

function isNonDefault(preference: SortPreference): boolean {
  return (
    preference.field !== DEFAULT_SORT_PREFERENCE.field ||
    preference.direction !== DEFAULT_SORT_PREFERENCE.direction
  );
}

export function SortButton({ preference, onChange }: SortButtonProps) {
  const { t } = useI18n();
  const fields: { value: SortField; label: string }[] = [
    { value: "date_captured", label: t("filters.sortDateCaptured") },
    { value: "filename", label: t("filters.sortFilename") },
  ];
  const directions: { value: SortDirection; label: string }[] = [
    { value: "desc", label: t("filters.sortDescending") },
    { value: "asc", label: t("filters.sortAscending") },
  ];

  const active = isNonDefault(preference);
  const Icon = preference.direction === "asc" ? ArrowUpAZ : ArrowDownAZ;

  return (
    <details className="dropdown dropdown-end">
      <summary
        className={`btn btn-sm list-none ${active ? "btn-primary" : "btn-ghost"}`}
        aria-label={t("filters.sortAria")}
      >
        <Icon size={14} className="shrink-0" />
        <span>{t("filters.sort")}</span>
      </summary>

      <div className="dropdown-content z-20 mt-2 w-52 rounded-box border border-base-300 bg-base-100 p-2 shadow">
        <p className="px-2 py-1 text-xs font-semibold text-base-content/50 uppercase tracking-wide">
          {t("filters.sortBy")}
        </p>
        {fields.map(({ value, label }) => (
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
          {t("filters.sortOrder")}
        </p>
        {directions.map(({ value, label }) => (
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
