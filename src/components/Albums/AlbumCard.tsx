import { useEffect, useState } from "react";
import { getAssetThumbnail } from "../../api/tauri";
import type { AlbumSummary } from "../../types";

interface AlbumCardProps {
  album: AlbumSummary;
  isOwned: boolean;
  dateLabel: string;
  onClick?: () => void;
}
import { useI18n } from "../../i18n";
import { useAlbumLocalStatus } from "../../hooks/useAlbumLocalStatus";

export function AlbumCard({ album, isOwned, dateLabel, onClick }: AlbumCardProps) {
  const { t } = useI18n();
  const [cover, setCover] = useState<string | null>(null);
  const isSavedLocally = Boolean(album.savedLocalFolderPath?.trim());
  const localStatus = useAlbumLocalStatus(album.id, album.savedLocalFolderPath);

  useEffect(() => {
    let cancelled = false;

    async function loadCover() {
      if (!album.albumThumbnailAssetId) {
        setCover(null);
        return;
      }

      try {
        const value = await getAssetThumbnail(album.albumThumbnailAssetId);
        if (!cancelled) {
          setCover(value);
        }
      } catch {
        if (!cancelled) {
          setCover(null);
        }
      }
    }

    void loadCover();

    return () => {
      cancelled = true;
    };
  }, [album.albumThumbnailAssetId]);

  return (
    <button
      type="button"
      onClick={onClick}
      className="card card-sm overflow-hidden rounded-xl bg-base-100 text-left shadow-sm ring-1 ring-base-300/80 transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <figure className="aspect-video bg-base-200">
        {cover ? (
          <img
            src={cover}
            alt={album.albumName}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm text-base-content/50">
            No cover
          </div>
        )}

        {isSavedLocally ? (
          <div className="absolute top-2 left-2">
            <span
              className={`badge badge-sm ${localStatus.data?.missingCount === 0 ? "badge-success" : "badge-warning"}`}
            >
              {localStatus.data
                ? localStatus.data.missingCount === 0
                  ? t("albums.savedLocally")
                  : t("albums.missingLocalFiles").replace(
                      "{count}",
                      String(localStatus.data.missingCount),
                    )
                : localStatus.isError
                  ? t("albums.localStatusFailed")
                  : t("albums.checkingLocal")}
            </span>
          </div>
        ) : null}
      </figure>

      <div className="card-body gap-1 p-3">
        <h3 className="line-clamp-2 text-sm font-semibold text-base-content">{album.albumName}</h3>
        <p className="text-xs text-base-content/60">{dateLabel}</p>
        <div className="mt-1 flex items-center gap-2 text-xs text-base-content/70">
          <span>{album.assetCount ?? 0} items</span>
          <span>•</span>
          <span>{isOwned ? "Owned" : "Shared"}</span>
        </div>
      </div>
    </button>
  );
}
