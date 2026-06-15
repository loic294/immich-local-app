import { User } from "lucide-react";
import { useI18n } from "../../i18n";

interface MyPhotosFilterProps {
  /** When true, only assets matching My Photos rules are shown. */
  active: boolean;
  onChange: (active: boolean) => void;
}

/** Toggle that limits the grid to assets matching My Photos rules. */
export function MyPhotosFilter({ active, onChange }: MyPhotosFilterProps) {
  const { t } = useI18n();

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <button
        type="button"
        className={`btn btn-sm ${active ? "btn-primary" : "btn-ghost"}`}
        onClick={() => onChange(!active)}
        aria-pressed={active}
        aria-label={t("filters.myPhotosAria")}
      >
        <User size={16} />
        {t("filters.myPhotos")}
      </button>
    </div>
  );
}
