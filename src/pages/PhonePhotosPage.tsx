import { RefreshCw, Smartphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppTopBar } from "../components/Layout/AppTopBar";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { PhotoGrid } from "../components/PhotoGrid/PhotoGrid";
import { FilterBar } from "../components/Filters/FilterBar";
import { PhonePhotosInfoCard } from "../components/PhonePhotos/PhonePhotosInfoCard";
import { useFolderAssets } from "../hooks/useFolderAssets";
import { useFolderRefresh } from "../hooks/useFolderRefresh";
import { useAssetFilters } from "../hooks/useAssetFilters";
import { useSortPreference } from "../hooks/useSortPreference";
import { useSettings } from "../hooks/useSettings";
import {
  addAssetsToAlbum,
  createAlbumWithAssets,
  createShareLinkForAssets,
  fetchAlbums,
  getCachedFolderFullGridLayout,
} from "../api/tauri";
import { deleteAssets } from "../api/deletion";
import type { Session } from "../hooks/useSession";
import { criteriaWithQuery, type ViewScope } from "../types";
import { usePhonePhotosDefaults, usePhonePhotosI18n } from "../i18n/phonePhotos";

interface PhonePhotosPageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
}

const FIXED_SECTION_SELECTOR = [
  '[data-test="phone-photos-header"]',
  '[data-test="phone-photos-info-card"]',
  '[data-test="error-alert"]',
].join(",");

export function PhonePhotosPage({ session, onNavigate, onLogout }: PhonePhotosPageProps) {
  const t = usePhonePhotosI18n();
  const defaults = usePhonePhotosDefaults();
  const settingsQuery = useSettings();
  const settings = settingsQuery.data;
  const folderPath = settings?.phonePhotosFolderPath ?? "";
  const hasFolder = folderPath.length > 0;
  const infoTitle = settings?.phonePhotosInfoTitle.trim() || defaults.title;
  const infoDescription = settings?.phonePhotosInfoDescription.trim() || defaults.description;

  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [selectionCommand, setSelectionCommand] = useState<{
    type: "clear" | "select-all";
    nonce: number;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [photoGridHeight, setPhotoGridHeight] = useState(0);

  const filters = useAssetFilters(`phone-photos:${folderPath}`);
  useEffect(() => {
    const timeout = window.setTimeout(() => setSearchTerm(searchInput.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);
  const filterPayload = useMemo(
    () => criteriaWithQuery(filters.payload, searchTerm),
    [filters.payload, searchTerm],
  );
  const filterScope = useMemo<ViewScope>(
    () => ({ kind: "folder", path: folderPath, recursive: true }),
    [folderPath],
  );
  const {
    preference: sortPreference,
    setField: setSortField,
    setDirection: setSortDirection,
  } = useSortPreference();

  const assetsQuery = useFolderAssets(hasFolder, folderPath, filterPayload, sortPreference, true);
  const refresh = useFolderRefresh(folderPath);

  const allAssets = useMemo(
    () => assetsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [assetsQuery.data?.pages],
  );
  const hasAssets = allAssets.length > 0;
  const shouldShowPhotoGrid =
    hasFolder &&
    (assetsQuery.isLoading ||
      assetsQuery.isFetchingNextPage ||
      hasAssets ||
      searchTerm.length > 0 ||
      filters.isActive);
  const showInfoCard = settings?.phonePhotosInfoVisible === true;

  const loadFullLayout = useCallback(
    (containerWidth: number) =>
      getCachedFolderFullGridLayout(
        folderPath,
        containerWidth,
        filterPayload,
        sortPreference,
        true,
      ),
    [folderPath, filterPayload, sortPreference, refresh.refreshNonce, assetsQuery.dataUpdatedAt],
  );

  useEffect(() => {
    if (!shouldShowPhotoGrid) {
      setSelectedCount(0);
      setSelectedAssetIds([]);
      setSelectionCommand(null);
    }
  }, [shouldShowPhotoGrid]);

  // Size the grid to the space left below the header, info card and alerts.
  useEffect(() => {
    if (!contentRef.current) {
      return;
    }

    const calculateHeight = () => {
      const container = contentRef.current;
      if (!container) {
        return;
      }

      const padding = 16;
      let usedHeight = 0;
      container.querySelectorAll<HTMLElement>(FIXED_SECTION_SELECTOR).forEach((element) => {
        usedHeight += element.offsetHeight + 8;
      });

      const containerTop = container.getBoundingClientRect().top;
      const availableHeight = window.innerHeight - containerTop - padding - usedHeight;
      setPhotoGridHeight(Math.max(300, availableHeight));
    };

    calculateHeight();
    const resizeObserver = new ResizeObserver(calculateHeight);
    resizeObserver.observe(contentRef.current);
    const mutationObserver = new MutationObserver(() => {
      requestAnimationFrame(calculateHeight);
    });
    mutationObserver.observe(contentRef.current, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    window.addEventListener("resize", calculateHeight);

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", calculateHeight);
    };
  }, [folderPath]);

  const errorMessage = assetsQuery.isError
    ? t("loadFailed", { message: (assetsQuery.error as Error | null)?.message ?? "" })
    : refresh.error
      ? t("refreshFailed", { message: refresh.error })
      : null;
  const showEmptyFolder =
    hasFolder &&
    !assetsQuery.isLoading &&
    !assetsQuery.isError &&
    !hasAssets &&
    !shouldShowPhotoGrid;

  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="phonePhotos" onNavigate={onNavigate} />

      <section className="flex min-w-0 h-screen flex-col">
        <AppTopBar
          session={session}
          onLogout={onLogout}
          searchInput={searchInput}
          onSearchChange={setSearchInput}
          selectedAssetIds={selectedAssetIds}
          selectedCount={selectedCount}
          fetchAlbumsForSelection={fetchAlbums}
          onAddSelectedToAlbum={async ({ albumId, newAlbumName }) => {
            if (!selectedAssetIds.length) {
              return;
            }

            if (newAlbumName) {
              await createAlbumWithAssets(newAlbumName, selectedAssetIds);
              return;
            }

            if (albumId) {
              await addAssetsToAlbum(albumId, selectedAssetIds);
            }
          }}
          onCreateShareLinkForSelected={async () => createShareLinkForAssets(selectedAssetIds)}
          onArchiveSelected={async () => {
            try {
              await deleteAssets(selectedAssetIds);
            } finally {
              await assetsQuery.refetch();
            }
          }}
          onClearSelection={() => {
            setSelectionCommand({ type: "clear", nonce: Date.now() });
          }}
          onSelectAll={() => {
            setSelectionCommand({ type: "select-all", nonce: Date.now() });
          }}
          searchPlaceholder={t("searchPlaceholder")}
          showFilterButton={shouldShowPhotoGrid}
          searchScope={filterScope}
          filterActive={filters.isActive}
          filterOpen={filters.isOpen}
          onToggleFilter={filters.toggleOpen}
          showSortButton={shouldShowPhotoGrid}
          sortPreference={sortPreference}
          onSortChange={(patch) => {
            if (patch.field !== undefined) setSortField(patch.field);
            if (patch.direction !== undefined) setSortDirection(patch.direction);
          }}
        />

        {shouldShowPhotoGrid && (
          <FilterBar
            open={filters.isOpen}
            scope={filterScope}
            criteria={filters.criteria}
            isActive={filters.isActive}
            onChange={filters.update}
            onReset={filters.reset}
          />
        )}

        <section ref={contentRef} className="flex flex-col gap-2 p-2 sm:p-3 lg:p-4">
          <div
            data-test="phone-photos-header"
            className="flex shrink-0 items-center justify-between gap-2"
          >
            <h1 className="m-0 text-2xl font-bold text-base-content">{t("title")}</h1>
            {hasFolder && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!refresh.canRefresh || refresh.isRefreshing}
                onClick={refresh.refresh}
              >
                <RefreshCw
                  size={14}
                  aria-hidden="true"
                  className={refresh.isRefreshing ? "animate-spin" : undefined}
                />
                {refresh.isRefreshing ? t("refreshing") : t("refresh")}
              </button>
            )}
          </div>

          {showInfoCard && <PhonePhotosInfoCard title={infoTitle} description={infoDescription} />}

          {errorMessage && !hasAssets && (
            <div
              role="alert"
              data-test="error-alert"
              className="alert alert-error alert-soft shrink-0 text-sm"
            >
              <span>{errorMessage}</span>
            </div>
          )}

          {settingsQuery.isLoading ? (
            <p className="text-sm text-base-content/60">{t("loading")}</p>
          ) : !hasFolder ? (
            <div
              data-test="phone-photos-not-configured"
              className="flex flex-col items-center gap-3 rounded-xl bg-base-100 px-4 py-10 text-center ring-1 ring-base-300/80"
            >
              <Smartphone aria-hidden="true" className="size-8 text-base-content/50" />
              <div>
                <p className="m-0 font-semibold">{t("notConfigured")}</p>
                <p className="m-0 mt-1 text-sm text-base-content/60">{t("notConfiguredHelp")}</p>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  console.info("[phone_photos] opening settings from empty state");
                  onNavigate("settings");
                }}
              >
                {t("openSettings")}
              </button>
            </div>
          ) : shouldShowPhotoGrid ? (
            <PhotoGrid
              key={folderPath}
              assets={allAssets}
              onSelectedCountChange={setSelectedCount}
              onSelectedIdsChange={setSelectedAssetIds}
              selectionCommand={selectionCommand}
              isFetching={assetsQuery.isFetchingNextPage}
              hasNextPage={Boolean(assetsQuery.hasNextPage)}
              maxHeight={photoGridHeight}
              onLoadMore={() => assetsQuery.fetchNextPage().then(() => undefined)}
              loadFullLayout={loadFullLayout}
              viewScope={filterScope}
              viewCriteria={filterPayload}
            />
          ) : null}

          {showEmptyFolder && (
            <div
              data-test="phone-photos-empty"
              className="rounded-xl bg-base-100 px-4 py-6 text-center ring-1 ring-base-300/80"
            >
              <p className="m-0 font-semibold">{t("emptyFolder")}</p>
              <p className="m-0 mt-1 text-sm text-base-content/60">{t("emptyFolderHelp")}</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
