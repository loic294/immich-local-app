import { requestFixTime } from "../../api/time";
import { useSearchTimeI18n } from "../../i18n/searchTime";

type FixTimeButtonProps = {
  assetIds: string[];
  className?: string;
  /** Show the long "Update time" label instead of the compact "Update". */
  long?: boolean;
};

/** Small button that opens the Fix time dialog for the given assets. */
export function FixTimeButton({ assetIds, className, long = false }: FixTimeButtonProps) {
  const t = useSearchTimeI18n();
  return (
    <button
      type="button"
      className={className ?? "btn btn-xs btn-ghost"}
      disabled={assetIds.length === 0}
      title={t("updateTime")}
      onClick={(event) => {
        event.stopPropagation();
        requestFixTime(assetIds);
      }}
    >
      {long ? t("updateTime") : t("updateTimeShort")}
    </button>
  );
}
