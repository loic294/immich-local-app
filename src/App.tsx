import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Camera,
  Heart,
  Image,
  MapPin,
  Search,
  Share2,
  Upload,
  X,
} from "lucide-react";
import { authenticate } from "./api/tauri";
import { useAssets } from "./hooks/useAssets";
import { useMemories } from "./hooks/useMemories";
import { LoginScreen } from "./components/Auth/LoginScreen";
import { PhotoGrid } from "./components/PhotoGrid/PhotoGrid";
import { getAssetThumbnail } from "./api/tauri";
import type { AssetSummary, MemorySummary } from "./types";

type Session = {
  serverUrl: string;
  apiKey: string;
};

const AUTH_STORAGE_KEY = "immichLocalApp.auth";

function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      typeof parsed.serverUrl !== "string" ||
      typeof parsed.apiKey !== "string" ||
      !parsed.serverUrl ||
      !parsed.apiKey
    ) {
      return null;
    }

    return {
      serverUrl: parsed.serverUrl,
      apiKey: parsed.apiKey,
    };
  } catch {
    return null;
  }
}

function persistSession(session: Session) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

function clearPersistedSession() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [storedSession] = useState<Session | null>(() => readStoredSession());
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(
    Boolean(storedSession),
  );
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [memoryViewer, setMemoryViewer] = useState<{
    memoryIndex: number;
    assetIndex: number;
  } | null>(null);

  const assetsQuery = useAssets(Boolean(session), searchTerm);
  const memoriesQuery = useMemories(Boolean(session));

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

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearchTerm(searchInput.trim());
    }, 300);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [searchInput]);

  useEffect(() => {
    if (!storedSession) {
      return;
    }

    const sessionToRestore = storedSession;

    let cancelled = false;

    async function restoreSession() {
      setIsAuthenticating(true);
      setAuthError(null);

      try {
        await authenticate(sessionToRestore.serverUrl, sessionToRestore.apiKey);
        if (!cancelled) {
          setSession(sessionToRestore);
        }
      } catch {
        clearPersistedSession();
      } finally {
        if (!cancelled) {
          setIsAuthenticating(false);
          setIsRestoringSession(false);
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, [storedSession]);

  async function handleLogin(input: { serverUrl: string; apiKey: string }) {
    setAuthError(null);
    setIsAuthenticating(true);

    try {
      await authenticate(input.serverUrl, input.apiKey);
      const nextSession = { serverUrl: input.serverUrl, apiKey: input.apiKey };
      persistSession(nextSession);
      setSession(nextSession);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown authentication error";
      setAuthError(message);
      setSession(null);
      clearPersistedSession();
    } finally {
      setIsAuthenticating(false);
    }
  }

  if (isRestoringSession) {
    return (
      <main className="grid min-h-screen place-items-center bg-base-200 p-6">
        <section className="card w-full max-w-md border border-base-300 bg-base-100 shadow-xl">
          <div className="card-body">
            <h1 className="card-title text-2xl">Immich Local App</h1>
            <p className="text-sm text-base-content/70">
              Restoring previous session...
            </p>
          </div>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="min-h-screen bg-base-200 p-6">
        <LoginScreen
          onSubmit={handleLogin}
          initialServerUrl={storedSession?.serverUrl}
          initialApiKey={storedSession?.apiKey}
          isLoading={isAuthenticating}
          error={authError}
        />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="hidden flex-col gap-3 border-r border-base-300 bg-base-100 p-3 lg:flex">
        <div className="flex h-9 items-center gap-2 px-2 text-3xl font-bold text-primary">
          <div className="h-3.5 w-3.5 rounded-full bg-linear-to-br from-error via-warning to-info" />
          <span>immich.local</span>
        </div>

        <nav className="menu rounded-box bg-base-100 p-1">
          <button
            className="btn btn-sm btn-soft btn-primary justify-start"
            type="button"
          >
            <Image size={16} className="shrink-0" />
            <span>Photos</span>
          </button>
          <button className="btn btn-sm btn-ghost justify-start" type="button">
            <Search size={16} className="shrink-0" />
            <span>Explore</span>
          </button>
          <button className="btn btn-sm btn-ghost justify-start" type="button">
            <MapPin size={16} className="shrink-0" />
            <span>Map</span>
          </button>
          <button className="btn btn-sm btn-ghost justify-start" type="button">
            <Share2 size={16} className="shrink-0" />
            <span>Sharing</span>
          </button>
        </nav>

        <div className="px-2 text-xs font-semibold uppercase tracking-wide text-base-content/50">
          Library
        </div>
        <nav className="menu rounded-box bg-base-100 p-1">
          <button className="btn btn-sm btn-ghost justify-start" type="button">
            <Heart size={16} className="shrink-0" />
            <span>Favorites</span>
          </button>
        </nav>
      </aside>

      <section className="min-w-0">
        <header className="navbar border-b border-base-300 bg-base-100 px-3 sm:px-4">
          <div className="navbar-start">
            <label
              className="input input-bordered flex w-full min-w-[16rem] items-center gap-2 rounded-full sm:min-w-[20rem] lg:min-w-md"
              htmlFor="asset-search"
            >
              <Search size={16} className="text-base-content/60" />
              <input
                id="asset-search"
                placeholder="Search your photos"
                type="text"
                className="grow"
                value={searchInput}
                onChange={(event) => {
                  setSearchInput(event.target.value);
                }}
              />
            </label>
          </div>

          <div className="navbar-end gap-2">
            <button className="btn btn-sm btn-ghost" type="button">
              <Upload size={14} className="shrink-0" />
              <span>Upload</span>
            </button>
            <div className="flex items-center gap-2">
              <div className="avatar placeholder">
                <div className="w-8 rounded-full bg-primary text-primary-content text-xs font-bold">
                  LB
                </div>
              </div>
              <div>
                <p className="m-0 text-xs font-semibold text-base-content">
                  Loic
                </p>
                <p className="m-0 max-w-40 truncate text-[11px] text-base-content/60">
                  {session.serverUrl}
                </p>
              </div>
            </div>
          </div>
        </header>

        <section className="p-2 sm:p-3 lg:p-4">
          <MemoriesStrip
            memories={memoryItems}
            activeMemoryId={activeMemoryId}
            onOpenMemory={(memoryId) => {
              const memoryIndex = memoryItems.findIndex(
                (memory) => memory.id === memoryId,
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
          onChange={(next) => setMemoryViewer(next)}
        />
      ) : null}
    </main>
  );
}

function MemoriesStrip({
  memories,
  activeMemoryId,
  onOpenMemory,
}: {
  memories: MemoryItem[];
  activeMemoryId: string | null;
  onOpenMemory: (memoryId: string) => void;
}) {
  if (memories.length === 0) {
    return null;
  }

  return (
    <section className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {memories.map((memory) => (
        <MemoryCard
          key={memory.id}
          assetId={memory.coverAssetId}
          label={memory.label}
          name={memory.name}
          isActive={memory.id === activeMemoryId}
          onClick={() => onOpenMemory(memory.id)}
        />
      ))}
    </section>
  );
}

function MemoryCard({
  assetId,
  label,
  name,
  isActive,
  onClick,
}: {
  assetId: string;
  label: string;
  name: string;
  isActive: boolean;
  onClick: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const value = await getAssetThumbnail(assetId);
        if (!cancelled) {
          setSrc(value);
        }
      } catch {
        if (!cancelled) {
          setSrc(null);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  return (
    <button
      type="button"
      className={`relative aspect-[2.4/1] overflow-hidden rounded-lg border bg-base-300 text-left transition ${
        isActive
          ? "border-primary ring-2 ring-primary/60"
          : "border-transparent hover:border-base-300"
      }`}
      aria-label={name}
      onClick={onClick}
    >
      {src ? (
        <img alt={name} src={src} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-base-content/60">
          <Camera size={18} />
        </div>
      )}
      <p className="absolute bottom-2 left-2 m-0 text-lg font-semibold text-white drop-shadow">
        {label}
      </p>
    </button>
  );
}

type MemoryItem = {
  id: string;
  coverAssetId: string;
  label: string;
  name: string;
  assets: AssetSummary[];
};

function toMemoryItem(memory: MemorySummary): MemoryItem | null {
  const cover = memory.assets[0];
  if (!cover) {
    return null;
  }

  const label =
    memory.title?.trim() ||
    getYearsAgoLabel(memory.memoryAt, memory.year) ||
    "Memory";

  return {
    id: memory.id,
    coverAssetId: cover.id,
    label,
    name: cover.originalFileName,
    assets: memory.assets,
  };
}

function getYearsAgoLabel(
  memoryAt: string | null,
  year: number | null,
): string | null {
  const nowYear = new Date().getFullYear();

  if (typeof year === "number" && Number.isFinite(year)) {
    const years = Math.max(1, nowYear - year);
    return `${years} year${years > 1 ? "s" : ""} ago`;
  }

  if (memoryAt) {
    const date = new Date(memoryAt);
    if (!Number.isNaN(date.getTime())) {
      const years = Math.max(1, nowYear - date.getFullYear());
      return `${years} year${years > 1 ? "s" : ""} ago`;
    }
  }

  return null;
}

function MemoryFullscreenViewer({
  memories,
  memoryIndex,
  assetIndex,
  onClose,
  onChange,
}: {
  memories: MemoryItem[];
  memoryIndex: number;
  assetIndex: number;
  onClose: () => void;
  onChange: (next: { memoryIndex: number; assetIndex: number }) => void;
}) {
  const currentMemory = memories[memoryIndex];
  const currentAsset = currentMemory?.assets[assetIndex] ?? null;
  const previousMemory = memories[memoryIndex - 1] ?? null;
  const nextMemory = memories[memoryIndex + 1] ?? null;

  const [activeSrc, setActiveSrc] = useState<string | null>(null);
  const [previousSrc, setPreviousSrc] = useState<string | null>(null);
  const [upNextSrc, setUpNextSrc] = useState<string | null>(null);

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

function formatMemoryDate(value: string | null): string {
  if (!value) {
    return "Unknown date";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
