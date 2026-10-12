import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { createAlbumWithAssets, getCachedAlbums } from "../../api/tauri";
import {
  getMediaPreferences,
  importMedia,
  scanImportMedia,
  trackFeature,
  listMediaDevices,
} from "../../api/media";
import { useMediaLabels } from "../../i18n/media";
import { ImportTile } from "./ImportTile";
import { AlbumPickerModal } from "../Albums/AlbumPickerModal";
import { useAlbumPickerLabels } from "../../i18n/albumPicker";

interface ImportDialogProps {
  initialRoot: string | null;
  onClose: () => void;
  onImported: () => Promise<void>;
}
export function ImportDialog({ initialRoot, onClose, onImported }: ImportDialogProps) {
  const labels = useMediaLabels();
  const albumLabels = useAlbumPickerLabels();
  const [root, setRoot] = useState(initialRoot);
  const [kind, setKind] = useState("all");
  const [albumId, setAlbumId] = useState("");
  const [showAlbumPicker, setShowAlbumPicker] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastClicked = useRef<string | null>(null);
  const devices = useQuery({
    queryKey: ["media-devices"],
    queryFn: listMediaDevices,
    retry: false,
  });
  const [columns, setColumns] = useState(6);
  const [viewportWidth, setViewportWidth] = useState(900);
  const preferences = useQuery({ queryKey: ["media-preferences"], queryFn: getMediaPreferences });
  const albums = useQuery({ queryKey: ["media-import-albums"], queryFn: getCachedAlbums });
  const files = useInfiniteQuery({
    queryKey: ["import-files", root, kind],
    enabled: !!root,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => scanImportMedia(root ?? "", pageParam, kind),
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length : undefined),
    retry: false,
  });
  const loaded = useMemo(() => files.data?.pages.flatMap((page) => page.files) ?? [], [files.data]);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setViewportWidth(width);
      setColumns(Math.max(2, Math.min(8, Math.floor(width / 160))));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const rowHeight = viewportWidth / columns + 65;
  const rows = useVirtualizer({
    count: Math.ceil(loaded.length / columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 2,
  });
  useEffect(() => {
    rows.measure();
  }, [rowHeight, rows]);
  useEffect(() => {
    setSelected(new Set());
    lastClicked.current = null;
    setMessage(null);
  }, [root, kind]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (error) {
      console.error("[media:import] action failed", error);
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const pickFolder = () =>
    action(async () => {
      const result = await open({ directory: true, multiple: false });
      if (typeof result === "string") setRoot(result);
    });
  const runImport = () =>
    action(async () => {
      const count = await importMedia([...selected], albumId || null);
      setSelected(new Set());
      setMessage(`${count} ${labels.retained}`);
      trackFeature("import");
      await files.refetch();
      await onImported();
    });
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labels.importTitle}
      className="modal modal-open"
    >
      <div className="modal-box flex h-[92vh] w-[96vw] max-w-none flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-xl font-semibold">{labels.importTitle}</h2>
          <select
            className="select select-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label={labels.all}
            disabled={busy}
          >
            <option value="all">{labels.all}</option>
            <option value="photo">{labels.photos}</option>
            <option value="video">{labels.videos}</option>
          </select>
          <button
            type="button"
            className="btn btn-outline max-w-64"
            aria-label={albumLabels.choose}
            disabled={busy || !preferences.data}
            onClick={() => setShowAlbumPicker(true)}
          >
            <span className="truncate">
              {albums.data?.find((album) => album.id === albumId)?.albumName ??
                (preferences.data?.importRequiresAlbum ? labels.album : labels.unsorted)}
            </span>
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
            {labels.close}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={() =>
              setSelected(new Set(loaded.filter((f) => !f.alreadyImported).map((f) => f.path)))
            }
          >
            {labels.chooseNew}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={() => setSelected(new Set())}
          >
            {labels.clear}
          </button>
        </div>
        {showAlbumPicker && (
          <AlbumPickerModal
            title={albumLabels.choose}
            albums={albums.data ?? []}
            loading={albums.isLoading}
            error={albums.isError ? albumLabels.loadFailed : null}
            initialValue={albumId ? { albumId } : null}
            requiresConnection={false}
            allowEmpty={!!preferences.data && !preferences.data.importRequiresAlbum}
            emptyLabel={labels.unsorted}
            onClose={() => setShowAlbumPicker(false)}
            onConfirm={async (choice) => {
              if (choice?.newAlbumName) {
                const album = await createAlbumWithAssets(choice.newAlbumName, []);
                setAlbumId(album.id);
                await albums.refetch();
              } else {
                setAlbumId(choice?.albumId ?? "");
              }
            }}
          />
        )}
        {root && (
          <p className="truncate text-xs" title={root}>
            {root}
          </p>
        )}
        {(error || files.isError || albums.isError || preferences.isError) && (
          <p role="alert" className="text-error">
            {error ?? String(files.error ?? albums.error ?? preferences.error)}
          </p>
        )}
        {message && (
          <p role="status" className="text-success">
            {message}
          </p>
        )}
        {!root && (
          <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-4">
            <button className="btn btn-primary" disabled={busy} onClick={() => void pickFolder()}>
              {labels.browse}
            </button>
            {devices.isLoading && (
              <span className="loading loading-spinner" aria-label={labels.busy} />
            )}
            {devices.isError && (
              <p role="alert" className="text-error">
                {labels.deviceError}
              </p>
            )}
            {!!devices.data?.length && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-sm text-base-content/65">{labels.devices}</p>
                {devices.data.map((device) => (
                  <button
                    key={device}
                    className="btn btn-outline btn-sm"
                    onClick={() => setRoot(device)}
                  >
                    {device}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div
          ref={scrollRef}
          className={`min-h-0 overflow-y-auto ${root ? "flex-1" : "h-0"}`}
          onScroll={(e) => {
            const node = e.currentTarget;
            if (
              node.scrollHeight - node.scrollTop - node.clientHeight < 600 &&
              files.hasNextPage &&
              !files.isFetchingNextPage
            )
              void files.fetchNextPage();
          }}
        >
          <div className="relative w-full" style={{ height: rows.getTotalSize() }}>
            {rows.getVirtualItems().map((row) => (
              <div
                key={row.key}
                className="absolute left-0 top-0 grid w-full gap-3"
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  transform: `translateY(${row.start}px)`,
                }}
              >
                {loaded.slice(row.index * columns, (row.index + 1) * columns).map((file) => (
                  <ImportTile
                    key={file.path}
                    file={file}
                    checked={selected.has(file.path)}
                    disabled={busy}
                    onToggle={(event) => {
                      const anchor = lastClicked.current;
                      setSelected((previous) => {
                        const next = new Set(previous);
                        const from = loaded.findIndex((item) => item.path === anchor);
                        const to = loaded.findIndex((item) => item.path === file.path);
                        if (event.shiftKey && from >= 0) {
                          for (const item of loaded.slice(
                            Math.min(from, to),
                            Math.max(from, to) + 1,
                          )) {
                            if (!item.alreadyImported) next.add(item.path);
                          }
                        } else if (next.has(file.path)) next.delete(file.path);
                        else next.add(file.path);
                        return next;
                      });
                      lastClicked.current = file.path;
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
          {files.isFetching && (
            <p role="status" className="py-4">
              {labels.busy}
            </p>
          )}
          {files.hasNextPage && (
            <button
              className="btn my-4"
              disabled={files.isFetchingNextPage}
              onClick={() => void files.fetchNextPage()}
            >
              {labels.more}
            </button>
          )}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-base-300 pt-4">
          <p className="max-w-2xl text-sm text-base-content/65">{labels.sourceSafe}</p>
          <div
            className={`ml-auto ${preferences.data?.importRequiresAlbum && !albumId ? "tooltip tooltip-left" : ""}`}
            data-tip={
              preferences.data?.importRequiresAlbum && !albumId ? labels.albumRequired : undefined
            }
            tabIndex={preferences.data?.importRequiresAlbum && !albumId ? 0 : undefined}
          >
            <button
              className="btn btn-primary"
              disabled={
                busy ||
                !selected.size ||
                !preferences.data ||
                (preferences.data.importRequiresAlbum && !albumId)
              }
              onClick={() => void runImport()}
            >
              {busy ? labels.busy : `${labels.import} (${selected.size})`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
