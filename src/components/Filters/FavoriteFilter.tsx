import { Heart } from "lucide-react";
import { useI18n } from "../../i18n";

interface FavoriteFilterProps {
  /** When true, only favorites are shown. */
  active: boolean;
  onChange: (active: boolean) => void;
}

/** Toggle that limits the grid to favorited assets. */
export function FavoriteFilter({ active, onChange }: FavoriteFilterProps) {
  const { t } = useI18n();

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <button
        type="button"
        className={`btn btn-sm ${active ? "btn-error" : "btn-ghost"}`}
        onClick={() => onChange(!active)}
        aria-pressed={active}
        aria-label={t("filters.favoritesAria")}
      >
        <Heart size={16} className={active ? "fill-current" : ""} />
        {t("filters.favorites")}
      </button>
    </div>
  );
}
