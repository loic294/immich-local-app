import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAssetThumbnail } from "../../api/tauri";
import type { AlbumSummary } from "../../types";
import { useI18n } from "../../i18n";

interface AlbumPickerProps {
  albums: AlbumSummary[];
  value: string;
  onChange: (id: string) => void;
  thumbnails?: Record<string, string>;
  loading?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
  allowEmpty?: boolean;
}
function AlbumThumbnail({ album, src }: { album: AlbumSummary; src?: string }) {
  const thumbnail = useQuery({
    queryKey: ["album-picker-thumbnail", album.albumThumbnailAssetId],
    queryFn: () => getAssetThumbnail(album.albumThumbnailAssetId!),
    enabled: !src && !!album.albumThumbnailAssetId,
    staleTime: 60_000,
    retry: false,
  });
  return (
    <span className="avatar avatar-placeholder">
      <span className="h-8 w-8 overflow-hidden rounded-box bg-base-300 text-xs text-base-content/70">
        {src || thumbnail.data ? (
          <img src={src || thumbnail.data} alt="" />
        ) : (
          album.albumName.slice(0, 1).toUpperCase()
        )}
      </span>
    </span>
  );
}
export function AlbumPicker({
  albums,
  value,
  onChange,
  thumbnails,
  loading,
  disabled,
  emptyLabel,
  allowEmpty,
}: AlbumPickerProps) {
  const { t } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  const choose = (id: string) => {
    onChange(id);
    if (details.current) details.current.open = false;
  };
  return (
    <details ref={details} className="dropdown w-full">
      <summary
        className="btn btn-outline w-full justify-between"
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        {albums.find((album) => album.id === value)?.albumName ??
          emptyLabel ??
          t("selectionActions.selectAlbum")}
      </summary>
      <ul className="menu dropdown-content z-[130] mt-2 max-h-72 w-full overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow">
        {allowEmpty && (
          <li>
            <button type="button" onClick={() => choose("")}>
              {emptyLabel}
            </button>
          </li>
        )}
        {albums.length === 0 ? (
          <li>
            <span className="text-base-content/60">
              {t(loading ? "selectionActions.loadingAlbums" : "selectionActions.noAlbumsAvailable")}
            </span>
          </li>
        ) : (
          albums.map((album) => (
            <li key={album.id}>
              <button
                type="button"
                disabled={disabled}
                className={`justify-between ${value === album.id ? "menu-active" : ""}`}
                onClick={() => choose(album.id)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <AlbumThumbnail album={album} src={thumbnails?.[album.id]} />
                  <span className="max-w-52 truncate">{album.albumName}</span>
                </span>
                <span className="badge badge-sm badge-ghost">{album.assetCount ?? 0}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </details>
  );
}
