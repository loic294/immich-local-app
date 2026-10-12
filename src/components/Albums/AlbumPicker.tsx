import { useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Plus } from "lucide-react";
import { getAssetThumbnail } from "../../api/tauri";
import type { AlbumSummary } from "../../types";
import { useI18n } from "../../i18n";
import { useAlbumPickerLabels } from "../../i18n/albumPicker";
import { useRecentAlbums } from "../../hooks/useRecentAlbums";

export type AlbumChoice =
  | { albumId: string; newAlbumName?: never }
  | { newAlbumName: string; albumId?: never };

interface AlbumPickerProps {
  albums: AlbumSummary[];
  value: AlbumChoice | null;
  onChange: (choice: AlbumChoice | null) => void;
  loading?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
  allowEmpty?: boolean;
}

function AlbumThumbnail({ album }: { album: AlbumSummary }) {
  const thumbnail = useQuery({
    queryKey: ["album-picker-thumbnail", album.albumThumbnailAssetId],
    queryFn: () => getAssetThumbnail(album.albumThumbnailAssetId!),
    enabled: !!album.albumThumbnailAssetId,
    staleTime: 60_000,
    retry: false,
  });
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-base-300 text-xs">
      {thumbnail.data ? (
        <img src={thumbnail.data} alt="" className="h-full w-full object-cover" />
      ) : (
        album.albumName.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

/** Shared searchable existing/new album control; all mutation UI lives in AlbumPickerModal. */
export function AlbumPicker({
  albums,
  value,
  onChange,
  loading,
  disabled,
  emptyLabel,
  allowEmpty,
}: AlbumPickerProps) {
  const { t, locale } = useI18n();
  const labels = useAlbumPickerLabels();
  const recent = useRecentAlbums(5);
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(-1);
  const name = search.trim();
  const groups = useMemo(() => {
    const writable = albums.filter(
      (album) =>
        !album.isReadOnly &&
        album.albumName.toLocaleLowerCase(locale).includes(name.toLocaleLowerCase(locale)),
    );
    const byId = new Map(writable.map((album) => [album.id, album]));
    const recentAlbums = (recent.data ?? []).flatMap((album) =>
      byId.has(album.id) ? [byId.get(album.id)!] : [],
    );
    const recentIds = new Set(recentAlbums.map((album) => album.id));
    const years = new Map<string, AlbumSummary[]>();
    for (const album of writable.filter((album) => !recentIds.has(album.id))) {
      const date = new Date(album.endDate ?? album.startDate ?? album.createdAt ?? "");
      const year = Number.isNaN(date.getTime()) ? labels.undated : String(date.getFullYear());
      years.set(year, [...(years.get(year) ?? []), album]);
    }
    return [
      ...(recentAlbums.length ? [{ label: t("albums.recentTitle"), albums: recentAlbums }] : []),
      ...[...years]
        .sort(([a], [b]) =>
          a === labels.undated ? 1 : b === labels.undated ? -1 : b.localeCompare(a),
        )
        .map(([label, entries]) => ({
          label,
          albums: entries.sort(
            (a, b) =>
              (b.endDate ?? b.startDate ?? b.createdAt ?? "").localeCompare(
                a.endDate ?? a.startDate ?? a.createdAt ?? "",
              ) || a.albumName.localeCompare(b.albumName, locale),
          ),
        })),
    ];
  }, [albums, name, recent.data, locale, labels.undated, t]);
  const selectedLabel = value?.albumId
    ? albums.find((album) => album.id === value.albumId)?.albumName
    : value?.newAlbumName
      ? `${labels.newAlbum} — ${value.newAlbumName}`
      : emptyLabel;
  const options: {
    key: string;
    label: string;
    choice: AlbumChoice | null;
    album?: AlbumSummary;
    group?: string;
  }[] = [
    ...(allowEmpty
      ? [{ key: "empty", label: emptyLabel ?? t("selectionActions.selectAlbum"), choice: null }]
      : []),
    ...groups.flatMap((group) =>
      group.albums.map((album, index) => ({
        key: album.id,
        label: album.albumName,
        choice: { albumId: album.id },
        album,
        group: index === 0 ? group.label : undefined,
      })),
    ),
    ...(name && !loading
      ? [{ key: "new", label: `${labels.newAlbum} — ${name}`, choice: { newAlbumName: name } }]
      : []),
  ];
  const choose = (index: number) => {
    const option = options[index];
    if (!option || disabled) return;
    onChange(option.choice);
    setExpanded(false);
    setSearch("");
    setActive(-1);
    inputRef.current?.focus();
  };
  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false);
          setSearch("");
        }
      }}
    >
      <div className="input flex w-full items-center">
        <input
          ref={inputRef}
          role="combobox"
          aria-label={labels.search}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={`${id}-list`}
          aria-activedescendant={expanded && active >= 0 ? `${id}-${active}` : undefined}
          value={expanded ? search : (selectedLabel ?? "")}
          placeholder={labels.search}
          disabled={disabled}
          onFocus={() => {
            setExpanded(true);
            setActive(-1);
          }}
          onClick={() => setExpanded(true)}
          onChange={(event) => {
            setSearch(event.target.value);
            setActive(-1);
            setExpanded(true);
            onChange(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && expanded) {
              event.preventDefault();
              event.stopPropagation();
              setExpanded(false);
              setSearch("");
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              setExpanded(true);
              const next = options.length
                ? active < 0
                  ? event.key === "ArrowDown"
                    ? 0
                    : options.length - 1
                  : (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
                    options.length
                : -1;
              setActive(next);
              document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest" });
            }
            if (event.key === "Enter" && expanded) {
              event.preventDefault();
              event.stopPropagation();
              choose(active);
            }
          }}
        />
        <ChevronDown size={16} aria-hidden="true" />
      </div>
      {expanded && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={labels.choose}
          className="mt-1 max-h-[min(16rem,35dvh)] overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow-xl"
        >
          {options.map((option, index) => (
            <li key={option.key} role="presentation">
              {option.group && (
                <p className="px-2 pb-1 pt-3 text-xs font-semibold text-base-content/60">
                  {option.group}
                </p>
              )}
              <button
                id={`${id}-${index}`}
                role="option"
                aria-selected={
                  value?.albumId
                    ? value.albumId === option.album?.id
                    : value?.newAlbumName
                      ? option.key === "new"
                      : option.key === "empty"
                }
                type="button"
                tabIndex={-1}
                className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-base-200 ${active === index ? "bg-base-200" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                {option.album ? (
                  <AlbumThumbnail album={option.album} />
                ) : option.key === "new" ? (
                  <Plus size={18} />
                ) : (
                  <Check size={18} />
                )}
                <span className="min-w-0 flex-1 break-words">{option.label}</span>
                {option.album && (
                  <span className="badge badge-sm badge-ghost">{option.album.assetCount ?? 0}</span>
                )}
              </button>
            </li>
          ))}
          {loading && (
            <li role="presentation" className="p-2 text-sm text-base-content/60">
              {t("selectionActions.loadingAlbums")}
            </li>
          )}
          {!loading && !options.length && (
            <li role="presentation" className="p-2 text-sm text-base-content/60">
              {name ? labels.noResults : t("selectionActions.noAlbumsAvailable")}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
