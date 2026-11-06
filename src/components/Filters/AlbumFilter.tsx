import type { AlbumMembershipFilter } from "../../types";
import { useI18n } from "../../i18n";

interface AlbumFilterProps {
  /** The selected album membership, or null for every photo. */
  value: AlbumMembershipFilter | null;
  /** Greys the control out, e.g. while viewing a single album. */
  disabled: boolean;
  onChange: (value: AlbumMembershipFilter | null) => void;
}

/**
 * daisyUI select that limits the grid to photos that are (or are not) in at
 * least one album. The empty option clears the filter.
 */
export function AlbumFilter({ value, disabled, onChange }: AlbumFilterProps) {
  const { t } = useI18n();
  const options: { value: AlbumMembershipFilter; label: string }[] = [
    { value: "in_album", label: t("filters.inAlbum") },
    { value: "not_in_album", label: t("filters.notInAlbum") },
  ];

  return (
    <div
      className="flex shrink-0 flex-col gap-1"
      title={disabled ? t("filters.albumDisabledHint") : undefined}
    >
      <select
        className="select select-sm z-10 w-40"
        value={disabled ? "" : (value ?? "")}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === "" ? null : (next as AlbumMembershipFilter));
        }}
        aria-label={t("filters.albumAria")}
      >
        <option value="">{t("filters.allAlbumStates")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
