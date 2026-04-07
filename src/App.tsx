import { useEffect, useMemo, useState } from "react";
import {
  Camera,
  Heart,
  Image,
  MapPin,
  Search,
  Share2,
  Upload,
} from "lucide-react";
import { authenticate } from "./api/tauri";
import { useAssets } from "./hooks/useAssets";
import { LoginScreen } from "./components/Auth/LoginScreen";
import { PhotoGrid } from "./components/PhotoGrid/PhotoGrid";
import { getAssetThumbnail } from "./api/tauri";
import type { AssetSummary } from "./types";

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

  const assetsQuery = useAssets(Boolean(session));

  const assets = useMemo(
    () => assetsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [assetsQuery.data],
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [activeMemoryKey, setActiveMemoryKey] = useState<string | null>(null);

  const memoryItems = useMemo(() => buildMemories(assets), [assets]);

  const filteredAssets = useMemo(() => {
    let list = assets;

    if (activeMemoryKey) {
      list = list.filter(
        (asset) => toMonthDayKey(asset.fileCreatedAt) === activeMemoryKey,
      );
    }

    const term = searchTerm.trim().toLowerCase();
    if (!term) {
      return list;
    }

    return list.filter((asset) => {
      const filename = asset.originalFileName.toLowerCase();
      const dateText = asset.fileCreatedAt
        ? new Date(asset.fileCreatedAt).toLocaleDateString().toLowerCase()
        : "";

      return filename.includes(term) || dateText.includes(term);
    });
  }, [activeMemoryKey, assets, searchTerm]);

  const activeMemory = useMemo(
    () => memoryItems.find((item) => item.key === activeMemoryKey) ?? null,
    [activeMemoryKey, memoryItems],
  );

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
      <main className="page">
        <section className="card">
          <h1>Immich Local App</h1>
          <p className="subtitle">Restoring previous session...</p>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="page">
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
    <main className="app-layout">
      <aside className="left-nav">
        <div className="brand">
          <div className="brand-dot" />
          <span>immich</span>
        </div>

        <nav className="nav-list">
          <button className="nav-item nav-item-active" type="button">
            <Image size={16} />
            <span>Photos</span>
          </button>
          <button className="nav-item" type="button">
            <Search size={16} />
            <span>Explore</span>
          </button>
          <button className="nav-item" type="button">
            <MapPin size={16} />
            <span>Map</span>
          </button>
          <button className="nav-item" type="button">
            <Share2 size={16} />
            <span>Sharing</span>
          </button>
        </nav>

        <div className="nav-group-title">Library</div>
        <nav className="nav-list">
          <button className="nav-item" type="button">
            <Heart size={16} />
            <span>Favorites</span>
          </button>
        </nav>
      </aside>

      <section className="content-shell">
        <header className="top-nav">
          <label className="searchbar" htmlFor="asset-search">
            <Search size={16} />
            <input
              id="asset-search"
              placeholder="Search your photos"
              type="text"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>

          <div className="top-actions">
            <button className="upload-btn" type="button">
              <Upload size={14} />
              <span>Upload</span>
            </button>
            <div className="account-chip">
              <div className="account-avatar">LB</div>
              <div>
                <p className="account-name">Loic</p>
                <p className="account-server">{session.serverUrl}</p>
              </div>
            </div>
          </div>
        </header>

        <section className="photos-content">
          <MemoriesStrip
            memories={memoryItems}
            activeMemoryKey={activeMemoryKey}
            onSelectMemory={(key) => {
              setActiveMemoryKey((current) => (current === key ? null : key));
            }}
          />

          {activeMemory || searchTerm.trim() ? (
            <div className="active-filters">
              {activeMemory ? (
                <button
                  type="button"
                  className="filter-chip"
                  onClick={() => setActiveMemoryKey(null)}
                >
                  Memory: {activeMemory.label} x
                </button>
              ) : null}
              {searchTerm.trim() ? (
                <button
                  type="button"
                  className="filter-chip"
                  onClick={() => setSearchTerm("")}
                >
                  Search: {searchTerm.trim()} x
                </button>
              ) : null}
            </div>
          ) : null}

          {assetsQuery.isError ? (
            <p className="error">{(assetsQuery.error as Error).message}</p>
          ) : (
            <PhotoGrid
              assets={filteredAssets}
              isFetching={assetsQuery.isFetchingNextPage}
              hasNextPage={Boolean(assetsQuery.hasNextPage)}
              onLoadMore={() => {
                void assetsQuery.fetchNextPage();
              }}
            />
          )}
        </section>
      </section>
    </main>
  );
}

function MemoriesStrip({
  memories,
  activeMemoryKey,
  onSelectMemory,
}: {
  memories: MemoryItem[];
  activeMemoryKey: string | null;
  onSelectMemory: (key: string) => void;
}) {
  if (memories.length === 0) {
    return null;
  }

  return (
    <section className="memories-strip">
      {memories.map((memory) => (
        <MemoryCard
          key={memory.key}
          assetId={memory.id}
          label={memory.label}
          name={memory.name}
          isActive={memory.key === activeMemoryKey}
          onClick={() => onSelectMemory(memory.key)}
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
      className={`memory-card ${isActive ? "memory-card-active" : ""}`}
      aria-label={name}
      onClick={onClick}
    >
      {src ? (
        <img alt={name} src={src} />
      ) : (
        <div className="memory-placeholder">
          <Camera size={18} />
        </div>
      )}
      <p>{label}</p>
    </button>
  );
}

type MemoryItem = {
  id: string;
  key: string;
  label: string;
  name: string;
  score: number;
};

function buildMemories(assets: AssetSummary[]): MemoryItem[] {
  const now = new Date();
  const candidates = assets
    .filter((asset) => asset.fileCreatedAt)
    .map((asset) => {
      const date = new Date(asset.fileCreatedAt as string);
      const years = Math.max(1, now.getFullYear() - date.getFullYear());
      const key = toMonthDayKey(asset.fileCreatedAt);

      return {
        id: asset.id,
        key,
        label: `${years} year${years > 1 ? "s" : ""} ago`,
        name: asset.originalFileName,
        score:
          Math.abs(now.getMonth() - date.getMonth()) * 31 +
          Math.abs(now.getDate() - date.getDate()),
      };
    })
    .sort((a, b) => a.score - b.score);

  const unique = new Map<string, MemoryItem>();
  for (const item of candidates) {
    if (!unique.has(item.key)) {
      unique.set(item.key, item);
    }
    if (unique.size >= 4) {
      break;
    }
  }

  return Array.from(unique.values());
}

function toMonthDayKey(fileCreatedAt: string | null): string {
  if (!fileCreatedAt) {
    return "unknown";
  }

  const date = new Date(fileCreatedAt);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
