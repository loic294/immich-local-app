import type { SyncStatus } from "../../hooks/useSyncStatus";
import { useI18n } from "../../i18n";

interface FullSyncProgressProps {
  syncStatus: SyncStatus;
}

export function FullSyncProgress({ syncStatus }: FullSyncProgressProps) {
  const { t } = useI18n();
  const preparation = syncStatus.preparation;
  let progress: number | undefined;
  let label: string;

  if (preparation?.stage === "people") {
    label = t("syncCard.preparingPeople");
  } else if (preparation?.stage === "albums") {
    const { completedAlbums, totalAlbums, processedAlbumAssets, totalAlbumAssets } = preparation;
    label =
      totalAlbums === null
        ? t("syncCard.fetchingAlbums")
        : t("syncCard.preparingAlbums", { processed: completedAlbums, total: totalAlbums });
    if (totalAlbums !== null && totalAlbums > 0) {
      const currentAlbumFraction =
        totalAlbumAssets !== null && totalAlbumAssets > 0
          ? Math.min(processedAlbumAssets / totalAlbumAssets, 1)
          : 0;
      progress = Math.min(((completedAlbums + currentAlbumFraction) / totalAlbums) * 100, 100);
    }
  } else {
    progress =
      syncStatus.totalAssets > 0
        ? Math.min(Math.round((syncStatus.processedAssets / syncStatus.totalAssets) * 100), 100)
        : undefined;
    label = t("syncCard.syncedCount", {
      processed: syncStatus.processedAssets,
      total: syncStatus.totalAssets,
    });
  }

  return (
    <div className="space-y-2">
      <progress
        className="progress progress-primary w-full"
        value={progress}
        max="100"
        aria-label={label}
      />
      <div className="space-y-1 text-xs text-base-content/70" aria-live="polite" aria-atomic="true">
        <div>{label}</div>
        {preparation?.stage === "albums" && preparation.totalAlbumAssets !== null && (
          <div>
            {t("syncCard.preparingAlbumAssets", {
              processed: preparation.processedAlbumAssets,
              total: preparation.totalAlbumAssets,
            })}
          </div>
        )}
        {preparation && preparation.accountCount > 1 && (
          <div>
            {t("syncCard.preparingAccount", {
              current: preparation.accountIndex,
              total: preparation.accountCount,
            })}
          </div>
        )}
      </div>
    </div>
  );
}
