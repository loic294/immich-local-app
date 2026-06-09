import { useCallback, useEffect, useMemo, useState } from "react";
import { useAssetDays } from "../hooks/useAssetDays";
import { useMemories } from "../hooks/useMemories";
import { AppTopBar } from "../components/Layout/AppTopBar";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { MemoriesStrip } from "../components/Memories/MemoriesStrip";
import { MemoryFullscreenViewer } from "../components/Memories/MemoryFullscreenViewer";
import { PhotoGrid } from "../components/PhotoGrid/PhotoGrid";
import {
  addAssetsToAlbum,
  createAlbumWithAssets,
  createShareLinkForAssets,
  fetchAlbums,
  getCachedAssetJumpTarget,
  getCachedTimelineLayout,
  getFullGridLayout,
  updateAssetVisibility,
} from "../api/tauri";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { toMemoryItem, type MemoryItem } from "../utils/memory";
import type { Session } from "../hooks/useSession";
import { ASSET_PAGE_SIZE, useAssetWindow } from "../hooks/useAssetWindow";
import { useRef } from "react";
import type { AssetFilter } from "../types";

interface PhotosPageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
  activePage?: AppPage;
  assetFilter?: AssetFilter;
  searchLabel?: string;
}

export function PhotosPage({
  session,
  onNavigate,
  onLogout,
  activePage = "photos",
  assetFilter = "all",
  searchLabel = "Search",
}: PhotosPageProps) {
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [archiveRefreshNonce, setArchiveRefreshNonce] = useState(0);
  const [selectedCount, setSelectedCount] = useState(0);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [selectionCommand, setSelectionCommand] = useState<{
    type: "clear" | "select-all";
    nonce: number;
  } | null>(null);
  const [memoryViewer, setMemoryViewer] = useState<{
    memoryIndex: number;
    assetIndex: number;
  } | null>(null);
  const { syncStatus } = useSyncStatus();
  const refreshToken = `${syncStatus?.lastSyncCompletedAt ?? ""}:${syncStatus?.lastCheckedAt ?? ""}:${archiveRefreshNonce}`;

  const contentRef = useRef<HTMLDivElement | null>(null);
  const [photoGridHeight, setPhotoGridHeight] = useState(0);

  const assetsWindow = useAssetWindow(
    true,
    searchTerm,
    refreshToken,
    assetFilter,
  );
  const assetDaysQuery = useAssetDays(
    true,
    searchTerm,
    refreshToken,
    assetFilter,
  );
  const memoriesQuery = useMemories(true);

  const assets = assetsWindow.assets;

  const memoryItems = useMemo(
    () =>
      (memoriesQuery.data ?? [])
        .map((memory) => toMemoryItem(memory))
        .filter((memory): memory is MemoryItem => memory !== null),
    [memoriesQuery.data],
  );

  const activeMemoryId =
    memoryViewer !== null
      ? (memoryItems[memoryViewer.memoryIndex]?.id ?? null)
      : null;

  // Debounced search
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearchTerm(searchInput.trim());
    }, 300);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [searchInput]);

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
      const memoryStrip = container.querySelector(
        '[data-test="memories-strip"]',
      ) as HTMLElement;
      const searchBar = container.querySelector(
        '[data-test="search-bar"]',
      ) as HTMLElement;
      const errorAlert = container.querySelector(
        '[data-test="error-alert"]',
      ) as HTMLElement;

      const padding = 16; // padding from p-2 sm:p-3 lg:p-4 (bottom only)
      let usedHeight = padding;

      if (memoryStrip) {
        usedHeight += memoryStrip.offsetHeight;
      }
      if (searchBar) {
        usedHeight += searchBar.offsetHeight + 4; // gap-2 is 8px but shared
      }
      if (errorAlert) {
        usedHeight += errorAlert.offsetHeight + 4; // gap-2 is 8px but shared
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
      // Recalculate after mutations (e.g., search bar appeared/disappeared)
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
  }, [memoryItems.length]);

  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage={activePage} onNavigate={onNavigate} />

      <section className="flex min-h-0 w-full flex-col">
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
            setArchiveRefreshNonce((current) => current + 1);
          }}
          onClearSelection={() => {
            setSelectionCommand({ type: "clear", nonce: Date.now() });
          }}
          onSelectAll={() => {
            setSelectionCommand({ type: "select-all", nonce: Date.now() });
          }}
        />

        <section
          ref={contentRef}
          className="flex flex-col gap-2 p-2 sm:p-3 lg:p-4"
        >
          <div data-test="memories-strip" className="shrink-0">
            <MemoriesStrip
              memories={memoryItems}
              activeMemoryId={activeMemoryId}
              onOpenMemory={(memoryId: string) => {
                const memoryIndex = memoryItems.findIndex(
                  (memory: MemoryItem) => memory.id === memoryId,
                );
                if (memoryIndex < 0) {
                  return;
                }

                setMemoryViewer({ memoryIndex, assetIndex: 0 });
                setSearchInput("");
              }}
            />
          </div>

          {searchInput.trim() ? (
            <div
              data-test="search-bar"
              className="shrink-0 flex flex-wrap gap-2"
            >
              {searchInput.trim() ? (
                <button
                  type="button"
                  className="btn btn-xs btn-soft btn-primary rounded-full"
                  onClick={() => {
                    setSearchInput("");
                    setSearchTerm("");
                  }}
                >
                  {searchLabel}: {searchInput.trim()} x
                </button>
              ) : null}
            </div>
          ) : null}

          {assetsWindow.error || memoriesQuery.isError ? (
            <div
              role="alert"
              data-test="error-alert"
              className="shrink-0 alert alert-error alert-soft text-sm"
            >
              <span>
                {assetsWindow.error?.message ??
                  (memoriesQuery.error as Error | null)?.message ??
                  "An error occurred"}
              </span>
            </div>
          ) : (
            <PhotoGrid
              assets={assets}
              hideArchivedAssets={assetFilter !== "archived"}
              onSelectedCountChange={setSelectedCount}
              onSelectedIdsChange={setSelectedAssetIds}
              selectionCommand={selectionCommand}
              isFetching={assetsWindow.isFetchingNextPage}
              isFetchingPrevious={assetsWindow.isFetchingPreviousPage}
              hasPreviousPage={assetsWindow.hasPreviousPage}
              availableDates={assetDaysQuery.data ?? []}
              hasNextPage={assetsWindow.hasNextPage}
              maxHeight={photoGridHeight}
              onLoadMore={() => assetsWindow.loadNextPage()}
              onLoadPrevious={() => assetsWindow.loadPreviousPage()}
              onJumpToDate={async (dateKey) => {
                const trimmedSearch = searchTerm.trim() || null;
                const jumpId = `jump-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const jumpStartedAt = performance.now();
                console.log("[PhotosPage] jump start", {
                  jumpId,
                  dateKey,
                  pageSize: ASSET_PAGE_SIZE,
                  search: trimmedSearch,
                });

                const jumpTargetStartedAt = performance.now();
                const jumpTarget = await getCachedAssetJumpTarget(
                  dateKey,
                  ASSET_PAGE_SIZE,
                  trimmedSearch,
                  assetFilter,
                );

                console.log("[PhotosPage] jump target resolved", {
                  jumpId,
                  dateKey,
                  found: Boolean(jumpTarget),
                  page: jumpTarget?.page ?? null,
                  durationMs: Math.round(
                    performance.now() - jumpTargetStartedAt,
                  ),
                });

                if (!jumpTarget) {
                  console.log("[PhotosPage] jump aborted (no target)", {
                    jumpId,
                    dateKey,
                    totalDurationMs: Math.round(
                      performance.now() - jumpStartedAt,
                    ),
                  });
                  return;
                }

                const replaceStartedAt = performance.now();
                await assetsWindow.jumpToPage(jumpTarget.page);
                console.log("[PhotosPage] jump page loaded", {
                  jumpId,
                  dateKey,
                  page: jumpTarget.page,
                  replaceDurationMs: Math.round(
                    performance.now() - replaceStartedAt,
                  ),
                  totalDurationMs: Math.round(
                    performance.now() - jumpStartedAt,
                  ),
                });
              }}
              loadFullLayout={useCallback(
                (containerWidth: number) =>
                  getFullGridLayout(
                    searchTerm.trim() || null,
                    containerWidth,
                    assetFilter,
                  ),
                [assetFilter, searchTerm],
              )}
              loadTimelineLayout={useCallback(
                (containerWidth: number) =>
                  getCachedTimelineLayout(
                    searchTerm.trim() || null,
                    containerWidth,
                    assetFilter,
                  ),
                [assetFilter, searchTerm],
              )}
            />
          )}
        </section>
      </section>

      {memoryViewer ? (
        <MemoryFullscreenViewer
          memories={memoryItems}
          memoryIndex={memoryViewer.memoryIndex}
          assetIndex={memoryViewer.assetIndex}
          onClose={() => setMemoryViewer(null)}
          onChange={(next: { memoryIndex: number; assetIndex: number }) =>
            setMemoryViewer(next)
          }
        />
      ) : null}
    </main>
  );
}
