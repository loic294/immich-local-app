import { X } from "lucide-react";
import type { AssetFilterCriteria, ViewScope } from "../../types";
import { useCameras, usePeople } from "../../hooks/useScopedFilterOptions";
import { RatingFilter } from "./RatingFilter";
import { FavoriteFilter } from "./FavoriteFilter";
import { MyPhotosFilter } from "./MyPhotosFilter";
import { TypeFilter } from "./TypeFilter";
import { CameraFilter } from "./CameraFilter";
import { PeopleFilter } from "./PeopleFilter";
import { useI18n } from "../../i18n";

interface FilterBarProps {
  /** Whether the bar is visible. */
  open: boolean;
  /** Identifies the current view so dropdown options can be scoped to it. */
  scope: ViewScope;
  criteria: AssetFilterCriteria;
  isActive: boolean;
  onChange: (patch: Partial<AssetFilterCriteria>) => void;
  onReset: () => void;
}

/**
 * Reusable filter bar shown directly under the header on any photo grid view
 * (all photos, albums, calendar months, folders). Combines the reusable
 * filter controls and scopes the Camera/People options to the current view.
 */
export function FilterBar({
  open,
  scope,
  criteria,
  isActive,
  onChange,
  onReset,
}: FilterBarProps) {
  const { t } = useI18n();
  const camerasQuery = useCameras(scope, open);
  const peopleQuery = usePeople(scope, open);

  if (!open) {
    return null;
  }

  return (
    <div className="flex flex-nowrap items-center gap-4 overflow-x-auto border-b border-base-300 bg-base-300 px-4 py-3">
      <MyPhotosFilter
        active={criteria.myPhotosOnly === true}
        onChange={(active) => onChange({ myPhotosOnly: active ? true : null })}
      />

      <RatingFilter
        rating={criteria.rating}
        mode={criteria.ratingMode ?? "gte"}
        onChange={(rating, ratingMode) => onChange({ rating, ratingMode })}
      />

      <FavoriteFilter
        active={criteria.favoriteOnly === true}
        onChange={(active) => onChange({ favoriteOnly: active ? true : null })}
      />

      <TypeFilter
        value={criteria.mediaType}
        onChange={(mediaType) => onChange({ mediaType })}
      />

      <CameraFilter
        value={criteria.camera}
        cameras={camerasQuery.data ?? []}
        isLoading={camerasQuery.isLoading}
        onChange={(camera) => onChange({ camera })}
      />

      <PeopleFilter
        value={criteria.personId}
        people={peopleQuery.data ?? []}
        isLoading={peopleQuery.isLoading}
        onChange={(personId) => onChange({ personId })}
      />

      {isActive && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onReset}
          aria-label={t("filters.clearAllAria")}
        >
          <X size={16} />
          {t("filters.clear")}
        </button>
      )}
    </div>
  );
}
