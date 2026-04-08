import { useEffect, useMemo, useState } from "react";
import { useAssetDays } from "../hooks/useAssetDays";
import { useMemories } from "../hooks/useMemories";
import { Header } from "../components/Layout/Header";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { MemoriesStrip } from "../components/Memories/MemoriesStrip";
import { MemoryFullscreenViewer } from "../components/Memories/MemoryFullscreenViewer";
import { PhotoGrid } from "../components/PhotoGrid/PhotoGrid";
import {
  getCachedAssetJumpTarget,
  getCachedTimelineLayout,
} from "../api/tauri";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { toMemoryItem, type MemoryItem } from "../utils/memory";
import type { Session } from "../hooks/useSession";
import { ASSET_PAGE_SIZE, useAssetWindow } from "../hooks/useAssetWindow";

interface PhotosPageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
}

export function PhotosPage({ session, onNavigate }: PhotosPageProps) {
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [memoryViewer, setMemoryViewer] = useState<{
    memoryIndex: number;
    assetIndex: number;
  } | null>(null);
  const { syncStatus } = useSyncStatus();
  const refreshToken = `${syncStatus?.lastSyncCompletedAt ?? ""}:${syncStatus?.lastCheckedAt ?? ""}`;

  const assetsWindow = useAssetWindow(true, searchTerm, refreshToken);
  const assetDaysQuery = useAssetDays(true, searchTerm, refreshToken);
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

  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="photos" onNavigate={onNavigate} />

      <section className="min-w-0">
        <Header
          searchInput={searchInput}
          onSearchChange={setSearchInput}
          serverUrl={session.serverUrl}
          userId={session.userId}
          userName={session.userName}
        />

        <section className="p-2 sm:p-3 lg:p-4">
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

          {searchInput.trim() ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {searchInput.trim() ? (
                <button
                  type="button"
                  className="btn btn-xs btn-soft btn-primary rounded-full"
                  onClick={() => {
                    setSearchInput("");
                    setSearchTerm("");
                  }}
                >
                  Search: {searchInput.trim()} x
                </button>
              ) : null}
            </div>
          ) : null}

          {assetsWindow.error || memoriesQuery.isError ? (
            <div role="alert" className="alert alert-error alert-soft text-sm">
              <span>
                {assetsWindow.error?.message ??
                  (memoriesQuery.error as Error | null)?.message ??
                  "An error occurred"}
              </span>
            </div>
          ) : (
            <PhotoGrid
              assets={assets}
              isFetching={assetsWindow.isFetchingNextPage}
              isFetchingPrevious={assetsWindow.isFetchingPreviousPage}
              hasPreviousPage={assetsWindow.hasPreviousPage}
              availableDates={assetDaysQuery.data ?? []}
              hasNextPage={assetsWindow.hasNextPage}
              onLoadMore={() => {
                void assetsWindow.loadNextPage();
              }}
              onLoadPrevious={() => {
                void assetsWindow.loadPreviousPage();
              }}
              onJumpToDate={async (dateKey) => {
                const jumpTarget = await getCachedAssetJumpTarget(
                  dateKey,
                  ASSET_PAGE_SIZE,
                  searchTerm.trim() || null,
                );

                if (!jumpTarget) {
                  return;
                }

                await assetsWindow.jumpToPage(jumpTarget.page);
              }}
              loadTimelineLayout={(containerWidth) =>
                getCachedTimelineLayout(
                  searchTerm.trim() || null,
                  containerWidth,
                )
              }
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
