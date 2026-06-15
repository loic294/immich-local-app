import { useI18n } from "../../i18n";

interface CameraFilterProps {
  /** Selected camera name, or null for all cameras. */
  value: string | null;
  /** Camera names available in the current view scope. */
  cameras: string[];
  isLoading: boolean;
  onChange: (value: string | null) => void;
}

/** daisyUI select listing the cameras present in the current view. */
export function CameraFilter({
  value,
  cameras,
  isLoading,
  onChange,
}: CameraFilterProps) {
  const { t } = useI18n();

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <select
        className="select select-sm z-10 w-48"
        value={value ?? ""}
        disabled={isLoading}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === "" ? null : next);
        }}
        aria-label={t("filters.cameraAria")}
      >
        <option value="">
          {isLoading ? t("filters.loading") : t("filters.allCameras")}
        </option>
        {cameras.map((camera) => (
          <option key={camera} value={camera}>
            {camera}
          </option>
        ))}
      </select>
    </div>
  );
}
