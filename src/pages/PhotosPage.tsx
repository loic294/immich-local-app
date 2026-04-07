import { useEffect, useMemo, useState } from "react";
import { useAssets } from "../hooks/useAssets";
import { useMemories } from "../hooks/useMemories";
import { Header } from "../components/Layout/Header";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { MemoriesStrip } from "../components/Memories/MemoriesStrip";
import { MemoryFullscreenViewer } from "../components/Memories/MemoryFullscreenViewer";
import { PhotoGrid } from "../components/PhotoGrid/PhotoGrid";
import { toMemoryItem, type MemoryItem } from "../utils/memory";
import type { Session } from "../hooks/useSession";

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

  const assetsQuery = useAssets(true, searchTerm);
  const memoriesQuery = useMemories(true);

  const assets = useMemo(
    () => assetsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [assetsQuery.data],
  );

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

          {assetsQuery.isError || memoriesQuery.isError ? (
            <div role="alert" className="alert alert-error alert-soft text-sm">
              <span>
                {(assetsQuery.error as Error | null)?.message ??
                  (memoriesQuery.error as Error | null)?.message ??
                  "An error occurred"}
              </span>
            </div>
          ) : (
            <PhotoGrid
              assets={assets}
              isFetching={assetsQuery.isFetchingNextPage}
              hasNextPage={Boolean(assetsQuery.hasNextPage)}
              onLoadMore={() => {
                void assetsQuery.fetchNextPage();
              }}
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
