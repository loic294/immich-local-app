import { useEffect, useState } from "react";
import { Images } from "lucide-react";
import { getAssetThumbnail } from "../../api/tauri";
import { useRecentAlbums } from "../../hooks/useRecentAlbums";
import { useI18n } from "../../i18n";
import type { AlbumSummary } from "../../types";

interface RecentAlbumsSectionProps {
  limit: number;
  onOpenAlbum: (albumId: string) => void;
}

export function RecentAlbumsSection({ limit, onOpenAlbum }: RecentAlbumsSectionProps) {
  const { t } = useI18n();
  const recentAlbums = useRecentAlbums(limit);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const albums = recentAlbums.data ?? [];

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      albums.map(async (album: AlbumSummary) => {
        if (!album.albumThumbnailAssetId) return [album.id, ""] as const;
        try {
          return [album.id, await getAssetThumbnail(album.albumThumbnailAssetId)] as const;
        } catch (error) {
          console.warn("[recent-albums] thumbnail load failed", { albumId: album.id, error });
          return [album.id, ""] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setThumbnails(Object.fromEntries(entries.filter(([, image]) => image)));
    });
    return () => {
      cancelled = true;
    };
  }, [albums]);

  if (limit <= 0 || albums.length === 0) return null;
  return (
    <section className="mt-3" aria-label={t("albums.recentTitle")}>
      <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-base-content/50">
        {t("albums.recentTitle")}
      </h2>
      <nav className="menu menu-vertical w-full rounded-box bg-base-100 p-1">
        {albums.map((album) => (
          <button
            key={album.id}
            type="button"
            className="btn btn-md btn-block w-full max-w-none btn-ghost justify-start gap-3 text-left text-sm font-medium"
            aria-label={t("albums.openRecent", { name: album.albumName })}
            onClick={() => onOpenAlbum(album.id)}
          >
            {thumbnails[album.id] ? (
              <img
                src={thumbnails[album.id]}
                alt=""
                className="h-8 w-8 shrink-0 rounded object-cover"
                loading="lazy"
              />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-base-200 text-base-content/50">
                <Images size={16} />
              </span>
            )}
            <span className="truncate">{album.albumName}</span>
          </button>
        ))}
      </nav>
    </section>
  );
}
