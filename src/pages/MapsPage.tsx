import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppTopBar } from "../components/Layout/AppTopBar";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { PhotoMap } from "../components/Maps/PhotoMap";
import { PhotoGrid } from "../components/PhotoGrid/PhotoGrid";
import { getCachedMapFullGridLayout } from "../api/browsing";
import { useMapBrowsing } from "../hooks/useMapBrowsing";
import type { Session } from "../hooks/useSession";
import { useBrowsingI18n } from "../i18n/browsing";
import type { MapFocus } from "../types/browsing";
import {
  addAssetsToAlbum,
  createAlbumWithAssets,
  createShareLinkForAssets,
  fetchAlbums,
} from "../api/tauri";

interface MapsPageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
  focus?: MapFocus | null;
}

export function MapsPage({ session, onNavigate, onLogout, focus = null }: MapsPageProps) {
  const t = useBrowsingI18n();
  const browsing = useMapBrowsing(focus?.id);
  const [search, setSearch] = useState("");
  const gridContainer = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(200);
  useEffect(() => {
    const container = gridContainer.current;
    if (!container) return;
    const observer = new ResizeObserver(() => setGridHeight(Math.max(120, container.clientHeight)));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionCommand, setSelectionCommand] = useState<{
    type: "clear" | "select-all";
    nonce: number;
  } | null>(null);
  const { bounds, assetIds, refreshNonce, isViewReady } = browsing;
  const visibleAssets = useMemo(
    () =>
      (browsing.assets.data ?? []).filter((asset) =>
        asset.originalFileName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      ),
    [browsing.assets.data, search],
  );
  const layoutIds = useMemo(
    () => (search.trim() ? visibleAssets.map((asset) => asset.id) : assetIds),
    [search, visibleAssets, assetIds],
  );
  const loadFullLayout = useCallback(
    (width: number) => {
      void refreshNonce;
      if (!isViewReady) return Promise.resolve({ sections: [] });
      return getCachedMapFullGridLayout(bounds, layoutIds, width);
    },
    [bounds, layoutIds, refreshNonce, isViewReady],
  );
  return (
    <main className="h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="maps" onNavigate={onNavigate} />
      <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <AppTopBar
          session={session}
          onLogout={onLogout}
          searchInput={search}
          onSearchChange={setSearch}
          selectedAssetIds={selectedIds}
          selectedCount={selectedIds.length}
          onClearSelection={() => setSelectionCommand({ type: "clear", nonce: Date.now() })}
          onSelectAll={() => setSelectionCommand({ type: "select-all", nonce: Date.now() })}
          fetchAlbumsForSelection={fetchAlbums}
          onAddSelectedToAlbum={async ({ albumId, newAlbumName }) => {
            if (newAlbumName) await createAlbumWithAssets(newAlbumName, selectedIds);
            else if (albumId) await addAssetsToAlbum(albumId, selectedIds);
          }}
          onCreateShareLinkForSelected={() => createShareLinkForAssets(selectedIds)}
        />
        <div className="flex items-center justify-between gap-2 p-3">
          <h1 className="text-xl font-semibold">{t("maps")}</h1>
          <div className="flex gap-2">
            {assetIds ? (
              <button className="btn btn-sm" onClick={() => browsing.setAssetIds(null)}>
                {t("allLocations")}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm"
              disabled={browsing.isRefreshing}
              onClick={() => void browsing.refresh()}
            >
              {browsing.isRefreshing ? (
                <span className="loading loading-spinner loading-xs" />
              ) : null}
              {t("refresh")}
            </button>
          </div>
        </div>
        {browsing.refreshError || browsing.assets.error || browsing.markers.error ? (
          <div className="alert alert-warning mx-3">
            {String(browsing.refreshError ?? browsing.assets.error ?? browsing.markers.error)}
          </div>
        ) : null}
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(240px,1fr)_minmax(200px,1fr)] gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_minmax(320px,38%)] xl:grid-rows-1">
          <PhotoMap
            markers={browsing.markers.data ?? []}
            focus={focus}
            onBoundsChange={browsing.setBounds}
            onSelect={browsing.setAssetIds}
          />
          <section className="flex min-h-0 min-w-0 flex-col rounded-box bg-base-100 p-2">
            <h2 className="mb-2 font-semibold">
              {t(assetIds ? "selected" : "viewport")} · {visibleAssets.length} {t("photos")}
            </h2>
            {browsing.assets.isPending ? <p>{t("loading")}</p> : null}
            {!browsing.assets.isPending && !browsing.assets.data?.length ? (
              <p className="p-4 text-base-content/60">{t("mapEmpty")}</p>
            ) : null}
            <div ref={gridContainer} className="min-h-0 flex-1">
              <PhotoGrid
                assets={visibleAssets}
                isFetching={browsing.assets.isFetching}
                hasNextPage={false}
                onSelectedIdsChange={setSelectedIds}
                selectionCommand={selectionCommand}
                onLoadMore={() => {}}
                loadFullLayout={loadFullLayout}
                maxHeight={gridHeight}
              />
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
