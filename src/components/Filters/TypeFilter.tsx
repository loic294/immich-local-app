import type { MediaTypeFilter } from "../../types";
import { useI18n } from "../../i18n";
import { FilterTooltip } from "./FilterTooltip";

interface TypeFilterProps {
  /** The selected media type, or null for all types. */
  value: MediaTypeFilter | null;
  onChange: (value: MediaTypeFilter | null) => void;
}

/**
 * daisyUI select for the media type. The empty option clears the type filter
 * (returns to "all types").
 */
export function TypeFilter({ value, onChange }: TypeFilterProps) {
  const { t } = useI18n();
  const options: { value: MediaTypeFilter; label: string }[] = [
    { value: "photo", label: t("filters.mediaPhoto") },
    { value: "raw", label: t("filters.mediaRaw") },
    { value: "photo_raw", label: t("filters.mediaPhotoRaw") },
    { value: "video", label: t("filters.mediaVideo") },
  ];

  return (
    <FilterTooltip className="shrink-0" content={t("filters.mediaTypeTooltip")}>
      <select
        className="select select-sm z-10 w-40"
        value={value ?? ""}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === "" ? null : (next as MediaTypeFilter));
        }}
        aria-label={t("filters.mediaTypeAria")}
      >
        <option value="">{t("filters.allTypes")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FilterTooltip>
  );
}
