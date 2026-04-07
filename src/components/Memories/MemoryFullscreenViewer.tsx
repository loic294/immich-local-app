import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { getAssetThumbnail } from "../../api/tauri";
import { MemoryItem } from "../../utils/memory";
import { formatMemoryDate } from "../../utils/date";

interface MemoryFullscreenViewerProps {
  memories: MemoryItem[];
  memoryIndex: number;
  assetIndex: number;
  onClose: () => void;
  onChange: (next: { memoryIndex: number; assetIndex: number }) => void;
}

export function MemoryFullscreenViewer({
  memories,
  memoryIndex,
  assetIndex,
  onClose,
  onChange,
}: MemoryFullscreenViewerProps) {
  const currentMemory = memories[memoryIndex];
  const currentAsset = currentMemory?.assets[assetIndex] ?? null;
  const previousMemory = memories[memoryIndex - 1] ?? null;
  const nextMemory = memories[memoryIndex + 1] ?? null;

  const [activeSrc, setActiveSrc] = useState<string | null>(null);
  const [previousSrc, setPreviousSrc] = useState<string | null>(null);
  const [upNextSrc, setUpNextSrc] = useState<string | null>(null);

  // Load current asset
  useEffect(() => {
    if (!currentAsset) {
      return;
    }

    let cancelled = false;
    async function load() {
      try {
        const value = await getAssetThumbnail(currentAsset.id);
        if (!cancelled) {
          setActiveSrc(value);
        }
      } catch {
        if (!cancelled) {
          setActiveSrc(null);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [currentAsset]);

  // Load previous memory
  useEffect(() => {
    if (!previousMemory) {
      setPreviousSrc(null);
      return;
    }

    const cover = previousMemory.assets[0];
    if (!cover) {
      setPreviousSrc(null);
      return;
    }

    let cancelled = false;
    async function load() {
      try {
        const value = await getAssetThumbnail(cover.id);
        if (!cancelled) {
          setPreviousSrc(value);
        }
      } catch {
        if (!cancelled) {
          setPreviousSrc(null);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [previousMemory]);

  // Load next memory
  useEffect(() => {
    if (!nextMemory) {
      setUpNextSrc(null);
      return;
    }

    const cover = nextMemory.assets[0];
    if (!cover) {
      setUpNextSrc(null);
      return;
    }

    let cancelled = false;
    async function load() {
      try {
        const value = await getAssetThumbnail(cover.id);
        if (!cancelled) {
          setUpNextSrc(value);
        }
      } catch {
        if (!cancelled) {
          setUpNextSrc(null);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [nextMemory]);

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key === "ArrowLeft") {
        if (assetIndex > 0) {
          onChange({ memoryIndex, assetIndex: assetIndex - 1 });
          return;
        }

        const previousMemory = memories[memoryIndex - 1];
        if (previousMemory) {
          onChange({
            memoryIndex: memoryIndex - 1,
            assetIndex: Math.max(0, previousMemory.assets.length - 1),
          });
        }
        return;
      }

      if (event.key === "ArrowRight") {
        if (currentMemory && assetIndex < currentMemory.assets.length - 1) {
          onChange({ memoryIndex, assetIndex: assetIndex + 1 });
          return;
        }

        if (memories[memoryIndex + 1]) {
          onChange({ memoryIndex: memoryIndex + 1, assetIndex: 0 });
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [assetIndex, currentMemory, memories, memoryIndex, onChange, onClose]);

  if (!currentMemory || !currentAsset) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-10000 flex flex-col bg-[radial-gradient(circle_at_20%_10%,#2f3035,#1f2024_55%,#18191d)] text-white"
      role="dialog"
      aria-modal="true"
    >
      <header className="grid h-14 grid-cols-[auto_auto_minmax(120px,1fr)_auto] items-center gap-3 border-b border-white/10 px-3">
        <button
          type="button"
          className="btn btn-ghost btn-xs text-white"
          aria-label="Close memory viewer"
          onClick={onClose}
        >
          <X size={16} />
        </button>

        <p className="m-0 text-sm">{currentMemory.label}</p>

        <div className="flex items-center gap-1.5" aria-hidden="true">
          {currentMemory.assets.map((asset) => (
            <span
              key={asset.id}
              className={`h-0.5 min-w-4 flex-1 rounded-full ${
                asset.id === currentAsset.id ? "bg-white" : "bg-white/30"
              }`}
            />
          ))}
        </div>

        <p className="m-0 text-sm">
          {assetIndex + 1}/{currentMemory.assets.length}
        </p>
      </header>

      <section className="grid flex-1 grid-cols-1 items-center gap-3 p-3 sm:grid-cols-[minmax(100px,160px)_minmax(0,1fr)_minmax(100px,160px)] lg:grid-cols-[minmax(140px,220px)_minmax(0,1fr)_minmax(140px,220px)] lg:gap-4 lg:p-4">
        <aside className="hidden min-h-0 sm:flex sm:justify-start">
          {previousMemory ? (
            <button
              type="button"
              className="relative h-[min(50vh,360px)] w-full overflow-hidden rounded-xl bg-black opacity-70 transition hover:opacity-95"
              onClick={() =>
                onChange({ memoryIndex: memoryIndex - 1, assetIndex: 0 })
              }
            >
              {previousSrc ? (
                <img
                  src={previousSrc}
                  alt={previousMemory.label}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-base-300 text-base-content/70">
                  Loading...
                </div>
              )}
              <span className="absolute left-1/2 top-1/2 inline-flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50">
                <ChevronLeft size={20} />
              </span>
              <div className="absolute bottom-2 right-2 text-right text-white drop-shadow">
                <p className="m-0 text-[10px] tracking-wide text-white/80">
                  PREVIOUS
                </p>
                <p className="m-0 text-lg font-semibold">
                  {previousMemory.label}
                </p>
              </div>
            </button>
          ) : null}
        </aside>

        <article className="max-h-[calc(100vh-110px)] overflow-hidden rounded-xl border border-white/15 bg-black">
          <div className="space-y-0.5 bg-black px-3 py-2">
            <p className="m-0 text-xs">
              {formatMemoryDate(currentAsset.fileCreatedAt)}
            </p>
            <p className="m-0 text-xs">{currentAsset.originalFileName}</p>
          </div>

          {activeSrc ? (
            <img
              className="h-[calc(100vh-170px)] w-full bg-black object-contain"
              src={activeSrc}
              alt={currentAsset.originalFileName}
            />
          ) : (
            <div className="flex h-[calc(100vh-170px)] w-full items-center justify-center bg-base-300 text-base-content/70">
              Loading...
            </div>
          )}
        </article>

        <aside className="hidden min-h-0 sm:flex sm:justify-end">
          {nextMemory ? (
            <button
              type="button"
              className="relative h-[min(50vh,360px)] w-full overflow-hidden rounded-xl bg-black opacity-70 transition hover:opacity-95"
              onClick={() =>
                onChange({ memoryIndex: memoryIndex + 1, assetIndex: 0 })
              }
            >
              {upNextSrc ? (
                <img
                  src={upNextSrc}
                  alt={nextMemory.label}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-base-300 text-base-content/70">
                  Loading...
                </div>
              )}
              <span className="absolute left-1/2 top-1/2 inline-flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50">
                <ChevronRight size={20} />
              </span>
              <div className="absolute bottom-2 left-2 text-left text-white drop-shadow">
                <p className="m-0 text-[10px] tracking-wide text-white/80">
                  UP NEXT
                </p>
                <p className="m-0 text-lg font-semibold">{nextMemory.label}</p>
              </div>
            </button>
          ) : null}
        </aside>
      </section>
    </div>
  );
}
