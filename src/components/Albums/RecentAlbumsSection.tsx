import { useEffect, useState } from "react";
import { Images } from "lucide-react";
import { getAssetThumbnail } from "../../api/tauri";
import { useI18n } from "../../i18n";
import type { AlbumSummary } from "../../types";
import { SidebarButton } from "../Layout/SidebarButton";

interface RecentAlbumsSectionProps {
  albums: AlbumSummary[];
  activeAlbumId?: string | null;
  onOpenAlbum: (albumId: string) => void;
}

export function RecentAlbumsSection({
  albums,
  activeAlbumId = null,
  onOpenAlbum,
}: RecentAlbumsSectionProps) {
  const { t } = useI18n();
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

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

  if (albums.length === 0) return null;
  return (
    <section className="shrink-0 space-y-1" aria-label={t("albums.recentTitle")}>
      <h2 className="px-3 text-xs font-semibold uppercase tracking-wide text-base-content/50">
        {t("albums.recentTitle")}
      </h2>
      <nav className="menu menu-vertical w-full rounded-box bg-base-100 p-1">
        {albums.map((album) => (
          <SidebarButton
            key={album.id}
            isActive={album.id === activeAlbumId}
            label={album.albumName}
            ariaLabel={t("albums.openRecent", { name: album.albumName })}
            onClick={() => onOpenAlbum(album.id)}
            leading={
              thumbnails[album.id] ? (
                <img
                  src={thumbnails[album.id]}
                  alt=""
                  className="h-8 w-8 rounded object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded bg-base-200 text-base-content/50">
                  <Images size={16} />
                </span>
              )
            }
          />
        ))}
      </nav>
    </section>
  );
}
