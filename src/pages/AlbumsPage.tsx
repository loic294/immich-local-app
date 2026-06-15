import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Share2,
  HardDrive,
  Check,
  LoaderCircle,
  FolderOpen,
} from "lucide-react";
import type { GridLayoutResponse } from "../types";
import { AlbumCard } from "../components/Albums/AlbumCard";
import { AlbumShareModal } from "../components/Albums/AlbumShareModal";
import { AlbumSaveProgressModal } from "../components/Albums/AlbumSaveProgressModal";
import { AppTopBar } from "../components/Layout/AppTopBar";
import { PageBackButton } from "../components/Layout/PageBackButton";
import { PhotoGrid } from "../components/PhotoGrid/PhotoGrid";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { FilterBar } from "../components/Filters/FilterBar";
import { useAlbumAssets } from "../hooks/useAlbumAssets";
import { useAlbums } from "../hooks/useAlbums";
import { useAssetFilters } from "../hooks/useAssetFilters";
import { useSortPreference } from "../hooks/useSortPreference";
import { useConnectionContext } from "../hooks/connectionContext";
import type { Session } from "../hooks/useSession";
import type { AlbumSummary, ViewScope } from "../types";
import { useI18n } from "../i18n";
import {
  addAssetsToAlbum,
  canManageAlbumSharing,
  createAlbumWithAssets,
  createShareLinkForAssets,
  fetchAlbums,
  getCachedAlbumFullGridLayout,
  openFolderInFileExplorer,
  openUrl,
  refreshAlbumAssets,
  saveAlbumLocally,
  updateAssetVisibility,
} from "../api/tauri";

interface AlbumsPageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
}

type AlbumFilter = "all" | "owned" | "shared";

export function AlbumsPage({ session, onNavigate, onLogout }: AlbumsPageProps) {
  const { locale, t } = useI18n();
  const [searchInput, setSearchInput] = useState("");
  const [filter, setFilter] = useState<AlbumFilter>("all");
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [selectionCommand, setSelectionCommand] = useState<{
    type: "clear" | "select-all";
    nonce: number;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [photoGridHeight, setPhotoGridHeight] = useState(0);
  const [showShareAlbumModal, setShowShareAlbumModal] = useState(false);
  const [canManageSharing, setCanManageSharing] = useState(false);
  const [savedAlbumPaths, setSavedAlbumPaths] = useState<Map<string, string>>(
    new Map(),
  );
  const [isSavingAlbum, setIsSavingAlbum] = useState(false);
  const [saveAlbumError, setSaveAlbumError] = useState<string | null>(null);
  const [showSaveProgressModal, setShowSaveProgressModal] = useState(false);
  // Bumped after a lazy on-open album refresh completes so the canvas grid
  // reloads its layout from the freshly-updated local cache.
  const [albumRefreshNonce, setAlbumRefreshNonce] = useState(0);
  const queryClient = useQueryClient();
  const { isOnline } = useConnectionContext();

  const filters = useAssetFilters(`album:${selectedAlbumId ?? ""}`);
  const filterPayload = filters.payload;
  const filterScope = useMemo<ViewScope>(
    () => ({ kind: "album", albumId: selectedAlbumId }),
    [selectedAlbumId],
  );
  const {
    preference: sortPreference,
    setField: setSortField,
    setDirection: setSortDirection,
  } = useSortPreference();

  const getValidSavedFolderPath = useCallback(
    (albumId: string): string | null => {
      const value = savedAlbumPaths.get(albumId);
      if (typeof value !== "string") {
        return null;
      }
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : null;
    },
    [savedAlbumPaths],
  );

  // Load saved albums from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("saved_album_paths");
      if (saved) {
        const paths = JSON.parse(saved) as Record<string, string>;
        const normalizedEntries = Object.entries(paths).filter(
          ([, folderPath]) =>
            typeof folderPath === "string" && folderPath.trim().length > 0,
        );
        setSavedAlbumPaths(new Map(normalizedEntries));
      }
    } catch (err) {
      console.error("[album-save-locally] Failed to load saved albums:", err);
    }
  }, []);

  // Persist saved albums to localStorage whenever they change
  useEffect(() => {
    try {
      const paths: Record<string, string> = {};
      for (const [albumId, folderPath] of savedAlbumPaths.entries()) {
        if (typeof folderPath === "string" && folderPath.trim().length > 0) {
          paths[albumId] = folderPath;
        }
      }
      localStorage.setItem("saved_album_paths", JSON.stringify(paths));
    } catch (err) {
      console.error(
        "[album-save-locally] Failed to persist saved albums:",
        err,
      );
    }
  }, [savedAlbumPaths]);

  const albumGridFullLayout = useCallback<
    (containerWidth: number) => Promise<GridLayoutResponse>
  >(
    (containerWidth) =>
      getCachedAlbumFullGridLayout(
        selectedAlbumId ?? "",
        containerWidth,
        filterPayload,
        sortPreference,
      ),
    // albumRefreshNonce is intentionally part of the deps so the grid reloads
    // its layout once the lazy on-open refresh has updated the local cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedAlbumId, albumRefreshNonce, filterPayload, sortPreference],
  );
  const albumLoadFullLayout =
    selectedAlbumId && searchInput.trim().length === 0
      ? albumGridFullLayout
      : undefined;

  const albumsQuery = useAlbums(true);
  const selectedAlbum = useMemo(
    () =>
      (albumsQuery.data ?? []).find((album) => album.id === selectedAlbumId) ??
      null,
    [albumsQuery.data, selectedAlbumId],
  );

  const albumAssetsQuery = useAlbumAssets(
    selectedAlbumId !== null,
    selectedAlbumId ?? "",
    filterPayload,
    sortPreference,
  );

  // Local-first lazy sync: when an album is opened, render from the local cache
  // immediately and refresh that single album from the server in the background.
  // Other albums are not touched (no full library re-sync). See
  // sync.instructions.md.
  useEffect(() => {
    if (!selectedAlbumId || isOnline !== true) {
      return;
    }

    let cancelled = false;
    const albumId = selectedAlbumId;

    void (async () => {
      try {
        await refreshAlbumAssets(albumId);
        if (cancelled) {
          return;
        }
        await queryClient.invalidateQueries({
          queryKey: ["album-assets-paged", albumId],
        });
        // Trigger a canvas layout reload from the updated cache.
        setAlbumRefreshNonce((nonce) => nonce + 1);
      } catch (err) {
        // Offline / transient failures keep the cached view; just log.
        console.warn("[albums] lazy album refresh failed", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedAlbumId, isOnline, queryClient]);

  // Calculate PhotoGrid height dynamically
  useEffect(() => {
    if (!contentRef.current) {
      return;
    }

    const calculateHeight = () => {
      if (!contentRef.current) {
        return;
      }

      const container = contentRef.current;
      const albumHeader = container.querySelector(
        '[data-test="album-header"]',
      ) as HTMLElement;
      const albumDescription = container.querySelector(
        '[data-test="album-description"]',
      ) as HTMLElement;
      const errorAlert = container.querySelector(
        '[data-test="error-alert"]',
      ) as HTMLElement;

      const padding = 16; // padding from p-2 sm:p-3 lg:p-4 (bottom only)
      let usedHeight = padding;

      if (albumHeader) {
        usedHeight += albumHeader.offsetHeight + 8; // gap
      }
      if (albumDescription) {
        usedHeight += albumDescription.offsetHeight + 8; // gap
      }
      if (errorAlert) {
        usedHeight += errorAlert.offsetHeight + 8; // gap
      }

      // Get the position of container element
      const containerTop = container.getBoundingClientRect().top;
      const containerHeight = window.innerHeight - containerTop - padding;
      const availableHeight = containerHeight - (usedHeight - padding);
      setPhotoGridHeight(Math.max(300, availableHeight));
    };

    // Calculate on mount and when window is resized
    calculateHeight();
    const resizeObserver = new ResizeObserver(calculateHeight);
    resizeObserver.observe(contentRef.current);
    const mutationObserver = new MutationObserver(() => {
      // Recalculate after mutations
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
  }, [selectedAlbumId]);

  const filteredAlbumAssets = useMemo(() => {
    const term = searchInput.trim().toLowerCase();
    const assets =
      albumAssetsQuery.data?.pages.flatMap((page) => page.items) ?? [];
    if (!term) {
      return assets;
    }

    return assets.filter((asset) =>
      asset.originalFileName.toLowerCase().includes(term),
    );
  }, [albumAssetsQuery.data?.pages, searchInput]);

  const filteredAlbums = useMemo(() => {
    const allAlbums = albumsQuery.data ?? [];
    const normalizedSearch = searchInput.trim().toLowerCase();

    return allAlbums
      .filter((album) => {
        if (filter === "owned") {
          return album.ownerId === session.userId;
        }
        if (filter === "shared") {
          return album.ownerId !== session.userId;
        }
        return true;
      })
      .filter((album) => {
        if (!normalizedSearch) {
          return true;
        }
        return album.albumName.toLowerCase().includes(normalizedSearch);
      })
      .sort((a, b) => {
        const left = getAlbumDateMs(a);
        const right = getAlbumDateMs(b);
        return right - left;
      });
  }, [albumsQuery.data, filter, searchInput, session.userId]);

  const groups = useMemo(() => {
    const byYear = new Map<number, AlbumSummary[]>();

    for (const album of filteredAlbums) {
      const year = getAlbumYear(album);
      const current = byYear.get(year) ?? [];
      current.push(album);
      byYear.set(year, current);
    }

    return [...byYear.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, albums]) => ({ year, albums }));
  }, [filteredAlbums]);

  useEffect(() => {
    if (!selectedAlbumId) {
      setSelectedCount(0);
      setSelectedAssetIds([]);
      setSelectionCommand(null);
    }
  }, [selectedAlbumId]);

  useEffect(() => {
    let cancelled = false;

    const evaluatePermission = async () => {
      if (!selectedAlbum) {
        setCanManageSharing(false);
        return;
      }

      if (selectedAlbum.ownerId === session.userId) {
        setCanManageSharing(true);
        return;
      }

      try {
        const canManage = await canManageAlbumSharing(selectedAlbum.id);
        if (!cancelled) {
          setCanManageSharing(canManage);
        }
      } catch {
        if (!cancelled) {
          setCanManageSharing(false);
        }
      }
    };

    void evaluatePermission();

    return () => {
      cancelled = true;
    };
  }, [selectedAlbum, session.userId]);

  const handleSaveAlbumLocally = async () => {
    if (!selectedAlbum) {
      console.warn(
        "[album-save-locally] save requested with no album selected",
      );
      return;
    }

    console.log(
      "[album-save-locally] save start",
      "albumId=",
      selectedAlbum.id,
      "albumName=",
      selectedAlbum.albumName,
      "assetCount=",
      selectedAlbum.assetCount ?? 0,
    );

    setIsSavingAlbum(true);
    setSaveAlbumError(null);
    setShowSaveProgressModal(true);

    try {
      const result = await saveAlbumLocally(selectedAlbum.id);
      setSavedAlbumPaths((prev) => {
        const updated = new Map(prev);
        updated.set(selectedAlbum.id, result.folderPath);
        return updated;
      });
      console.log(
        "[album-save-locally] save success",
        "albumId=",
        selectedAlbum.id,
        "folderPath=",
        result.folderPath,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setSaveAlbumError(errorMessage);
      console.error(
        "[album-save-locally] save failed",
        "albumId=",
        selectedAlbum.id,
        "error=",
        errorMessage,
        err,
      );
    } finally {
      setIsSavingAlbum(false);
      // Keep progress modal visible for a short moment after completion
      setTimeout(() => {
        setShowSaveProgressModal(false);
      }, 500);
    }
  };

  const handleOpenAlbumFolder = async () => {
    if (!selectedAlbum) {
      console.error(
        "[album-save-locally] open folder requested with no album selected",
      );
      return;
    }

    let folderPath = getValidSavedFolderPath(selectedAlbum.id);
    console.log(
      "[album-save-locally] open folder start",
      "albumId=",
      selectedAlbum.id,
      "folderPath=",
      folderPath,
    );

    if (!folderPath) {
      console.warn(
        "[album-save-locally] missing folder path in local storage, attempting to recover",
        selectedAlbum.id,
      );

      try {
        const result = await saveAlbumLocally(selectedAlbum.id);
        folderPath = result.folderPath?.trim() ?? "";

        if (!folderPath) {
          throw new Error("Save completed but returned an empty folder path");
        }

        setSavedAlbumPaths((prev) => {
          const updated = new Map(prev);
          updated.set(selectedAlbum.id, folderPath as string);
          return updated;
        });
        console.log(
          "[album-save-locally] recovered folder path from save_album_locally",
          selectedAlbum.id,
          folderPath,
        );
      } catch (err) {
        const errorMsg =
          err instanceof Error
            ? err.message
            : "Folder path not found for this album";
        setSaveAlbumError(errorMsg);
        console.error(
          "[album-save-locally] failed to recover missing folder path",
          selectedAlbum.id,
          err,
        );
        return;
      }
    }

    try {
      await openFolderInFileExplorer(folderPath);
      console.log(
        "[album-save-locally] open folder success",
        "albumId=",
        selectedAlbum.id,
        "folderPath=",
        folderPath,
      );
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to open folder";
      setSaveAlbumError(errorMsg);
      console.error(
        "[album-save-locally] open folder failed",
        "albumId=",
        selectedAlbum.id,
        "folderPath=",
        folderPath,
        "error=",
        errorMsg,
        err,
      );
    }
  };

  const isAlbumSavedLocally = selectedAlbum
    ? Boolean(getValidSavedFolderPath(selectedAlbum.id))
    : false;

  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="albums" onNavigate={onNavigate} />

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
          onCreateShareLinkForSelected={async () =>
            createShareLinkForAssets(selectedAssetIds)
          }
          onArchiveSelected={async () => {
            await Promise.all(
              selectedAssetIds.map((assetId) =>
                updateAssetVisibility(assetId, "archive"),
              ),
            );
            await albumAssetsQuery.refetch();
          }}
          onClearSelection={() => {
            setSelectionCommand({ type: "clear", nonce: Date.now() });
          }}
          onSelectAll={() => {
            setSelectionCommand({ type: "select-all", nonce: Date.now() });
          }}
          searchPlaceholder={
            selectedAlbumId
              ? t("albums.searchInAlbum")
              : t("albums.searchAlbums")
          }
          showFilterButton={selectedAlbumId !== null}
          filterActive={filters.isActive}
          filterOpen={filters.isOpen}
          onToggleFilter={filters.toggleOpen}
          showSortButton={selectedAlbumId !== null}
          sortPreference={sortPreference}
          onSortChange={(patch) => {
            if (patch.field !== undefined) setSortField(patch.field);
            if (patch.direction !== undefined)
              setSortDirection(patch.direction);
          }}
        />

        {selectedAlbumId !== null && (
          <FilterBar
            open={filters.isOpen}
            scope={filterScope}
            criteria={filters.criteria}
            isActive={filters.isActive}
            onChange={filters.update}
            onReset={filters.reset}
          />
        )}

        <section
          ref={contentRef}
          className={`p-2 sm:p-3 lg:p-4 ${
            selectedAlbum
              ? "flex min-h-0 flex-1 flex-col gap-2"
              : "min-h-0 flex-1 overflow-y-auto"
          }`}
        >
          {selectedAlbum ? (
            <>
              <div
                data-test="album-header"
                className="mb-1 flex items-center justify-between gap-2 shrink-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <PageBackButton
                    ariaLabel={t("albums.backToAlbumsAria")}
                    onClick={() => {
                      setSelectedAlbumId(null);
                      setSearchInput("");
                    }}
                  />
                  <h1 className="m-0 truncate text-xl font-bold text-base-content">
                    {selectedAlbum.albumName}
                  </h1>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!isAlbumSavedLocally ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary shrink-0"
                      onClick={handleSaveAlbumLocally}
                      disabled={isSavingAlbum}
                    >
                      {isSavingAlbum ? (
                        <>
                          <LoaderCircle size={16} className="animate-spin" />
                          {t("albums.saving")}
                        </>
                      ) : (
                        <>
                          <HardDrive size={16} />
                          {t("albums.saveLocally")}
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost shrink-0"
                      onClick={handleOpenAlbumFolder}
                    >
                      <FolderOpen size={16} />
                      {t("albums.openExplorer")}
                    </button>
                  )}

                  {canManageSharing ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary shrink-0"
                      onClick={() => setShowShareAlbumModal(true)}
                    >
                      <Link size={16} />
                      {t("albums.shareAlbum")}
                    </button>
                  ) : null}
                </div>
              </div>

              {saveAlbumError ? (
                <div role="alert" className="alert alert-error shrink-0">
                  <div className="flex items-start gap-2 min-w-0">
                    <span className="text-sm wrap-break-word">
                      {saveAlbumError}
                    </span>
                    <button
                      className="link link-hover text-sm ml-auto shrink-0"
                      onClick={() => setSaveAlbumError(null)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ) : null}

              {selectedAlbum.description ? (
                <div data-test="album-description" className="shrink-0">
                  <AlbumDescriptionSection
                    description={selectedAlbum.description}
                  />
                </div>
              ) : null}

              {albumAssetsQuery.isError && filteredAlbumAssets.length === 0 ? (
                <div
                  role="alert"
                  data-test="error-alert"
                  className="shrink-0 alert alert-error alert-soft text-sm"
                >
                  <span>
                    {(albumAssetsQuery.error as Error | null)?.message ??
                      t("albums.loadAlbumFailed")}
                  </span>
                </div>
              ) : (
                <PhotoGrid
                  assets={filteredAlbumAssets}
                  onSelectedCountChange={setSelectedCount}
                  onSelectedIdsChange={setSelectedAssetIds}
                  selectionCommand={selectionCommand}
                  isFetching={albumAssetsQuery.isFetchingNextPage}
                  hasNextPage={Boolean(albumAssetsQuery.hasNextPage)}
                  maxHeight={photoGridHeight}
                  onLoadMore={() =>
                    albumAssetsQuery.fetchNextPage().then(() => undefined)
                  }
                  loadFullLayout={albumLoadFullLayout}
                />
              )}

              <AlbumShareModal
                open={showShareAlbumModal}
                albumId={selectedAlbum.id}
                albumName={selectedAlbum.albumName}
                onClose={() => setShowShareAlbumModal(false)}
              />

              <AlbumSaveProgressModal
                open={showSaveProgressModal}
                albumName={selectedAlbum.albumName}
              />
            </>
          ) : (
            <section className="space-y-4 pb-2">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h1 className="m-0 text-2xl font-bold text-base-content">
                  {t("albums.title")}
                </h1>
                <div className="join">
                  <button
                    type="button"
                    className={`btn btn-sm join-item ${filter === "all" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setFilter("all")}
                  >
                    {t("albums.filterAll")}
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm join-item ${filter === "owned" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setFilter("owned")}
                  >
                    {t("albums.filterMine")}
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm join-item ${filter === "shared" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setFilter("shared")}
                  >
                    {t("albums.filterShared")}
                  </button>
                </div>
              </div>

              {albumsQuery.isError ? (
                <div
                  role="alert"
                  className="alert alert-error alert-soft text-sm"
                >
                  <span>
                    {(albumsQuery.error as Error | null)?.message ??
                      t("albums.loadAlbumsFailed")}
                  </span>
                </div>
              ) : null}

              {albumsQuery.isLoading ? (
                <div className="flex items-center gap-2 px-1 py-8 text-sm text-base-content/70">
                  <span className="loading loading-spinner loading-sm" />
                  {t("albums.loadingAlbums")}
                </div>
              ) : null}

              {!albumsQuery.isLoading && groups.length === 0 ? (
                <div className="alert alert-info alert-soft text-sm">
                  <span>{t("albums.noAlbumsForFilter")}</span>
                </div>
              ) : null}

              <div className="space-y-6">
                {groups.map((group) => (
                  <section key={group.year}>
                    <h2 className="mb-3 mt-0 text-3xl font-semibold text-base-content">
                      {group.year}{" "}
                      <span className="text-sm font-medium text-base-content/60">
                        {t("albums.albumsCount", {
                          count: group.albums.length,
                        })}
                      </span>
                    </h2>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                      {group.albums.map((album) => (
                        <AlbumCard
                          key={album.id}
                          album={album}
                          isOwned={album.ownerId === session.userId}
                          dateLabel={getAlbumDateLabel(
                            album,
                            locale,
                            t("albums.unknownDate"),
                          )}
                          onClick={() => {
                            setSelectedAlbumId(album.id);
                            setSearchInput("");
                          }}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </section>
          )}
        </section>
      </section>
    </main>
  );
}

function getAlbumYear(album: AlbumSummary): number {
  const value = album.endDate ?? album.startDate ?? album.createdAt;
  if (!value) {
    return new Date().getFullYear();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().getFullYear();
  }

  return parsed.getFullYear();
}

function getAlbumDateMs(album: AlbumSummary): number {
  const value = album.endDate ?? album.startDate ?? album.createdAt;
  if (!value) {
    return 0;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function getAlbumDateLabel(
  album: AlbumSummary,
  locale: string,
  unknownDate: string,
): string {
  const start = formatMonthYear(album.startDate ?? album.createdAt, locale);
  const end = formatMonthYear(album.endDate ?? album.updatedAt, locale);

  if (start && end && start !== end) {
    return `${start} - ${end}`;
  }

  return start ?? end ?? unknownDate;
}

function formatMonthYear(value: string | null, locale: string): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleDateString(locale, {
    month: "short",
    year: "numeric",
  });
}

const URL_REGEX = /https?:\/\/[^\s]+/g;
const ADOBE_HOSTNAME_REGEX = /adobe\.ly|lightroom\.adobe\.com|lightroom\.app/i;

function extractFirstUrl(text: string): string | null {
  const matches = text.match(URL_REGEX);
  return matches?.[0] ?? null;
}

function isAdobeUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return ADOBE_HOSTNAME_REGEX.test(hostname);
  } catch {
    return false;
  }
}

interface AlbumDescriptionSectionProps {
  description: string;
}

function AlbumDescriptionSection({
  description,
}: AlbumDescriptionSectionProps) {
  const { t } = useI18n();
  const url = extractFirstUrl(description);
  const textWithoutUrl = url
    ? description.replace(url, "").trim()
    : description;

  return (
    <div className="mb-4 space-y-3">
      {textWithoutUrl ? (
        <p className="text-sm text-base-content/80 whitespace-pre-wrap">
          {textWithoutUrl}
        </p>
      ) : null}
      {url ? (
        <button
          type="button"
          onClick={() => void openUrl(url)}
          className="card card-sm card-border bg-base-100 block w-full text-left no-underline hover:-translate-y-0.5 transition shadow-sm hover:shadow-md cursor-pointer"
        >
          <div className="card-body p-3 flex-row items-center gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="size-5 shrink-0 text-base-content/50"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
              />
            </svg>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-base-content">
                {isAdobeUrl(url) ? t("albums.lightroomCta") : url}
              </p>
              {isAdobeUrl(url) ? (
                <p className="text-xs text-base-content/50 truncate">{url}</p>
              ) : null}
            </div>
          </div>
        </button>
      ) : null}
    </div>
  );
}
