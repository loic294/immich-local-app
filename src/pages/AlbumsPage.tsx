import { useMemo, useState } from "react";
import { AlbumCard } from "../components/Albums/AlbumCard";
import { Header } from "../components/Layout/Header";
import { PhotoGrid } from "../components/PhotoGrid/PhotoGrid";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { useAlbumAssets } from "../hooks/useAlbumAssets";
import { useAlbums } from "../hooks/useAlbums";
import type { Session } from "../hooks/useSession";
import type { AlbumSummary } from "../types";
import { openUrl } from "../api/tauri";

interface AlbumsPageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
}

type AlbumFilter = "all" | "owned" | "shared";

export function AlbumsPage({ session, onNavigate }: AlbumsPageProps) {
  const [searchInput, setSearchInput] = useState("");
  const [filter, setFilter] = useState<AlbumFilter>("all");
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
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
  );

  const filteredAlbumAssets = useMemo(() => {
    const term = searchInput.trim().toLowerCase();
    const assets = albumAssetsQuery.data ?? [];
    if (!term) {
      return assets;
    }

    return assets.filter((asset) =>
      asset.originalFileName.toLowerCase().includes(term),
    );
  }, [albumAssetsQuery.data, searchInput]);

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

  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="albums" onNavigate={onNavigate} />

      <section className="flex min-w-0 h-screen flex-col">
        <Header
          searchInput={searchInput}
          onSearchChange={setSearchInput}
          serverUrl={session.serverUrl}
          searchPlaceholder={
            selectedAlbumId ? "Search photos in this album" : "Search albums"
          }
        />

        <section className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 lg:p-4">
          {selectedAlbum ? (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setSelectedAlbumId(null);
                    setSearchInput("");
                  }}
                >
                  Back to albums
                </button>
                <h1 className="m-0 text-lg font-bold text-base-content">
                  {selectedAlbum.albumName}
                </h1>
              </div>

              {selectedAlbum.description ? (
                <AlbumDescriptionSection description={selectedAlbum.description} />
              ) : null}

              {albumAssetsQuery.isError ? (
                <div
                  role="alert"
                  className="alert alert-error alert-soft text-sm"
                >
                  <span>
                    {(albumAssetsQuery.error as Error | null)?.message ??
                      "Could not load album photos"}
                  </span>
                </div>
              ) : (
                <PhotoGrid
                  assets={filteredAlbumAssets}
                  isFetching={albumAssetsQuery.isLoading}
                  hasNextPage={false}
                  onLoadMore={() => {}}
                />
              )}
            </section>
          ) : (
            <section>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h1 className="m-0 text-xl font-bold text-base-content">
                  Albums
                </h1>
                <div className="join">
                  <button
                    type="button"
                    className={`btn btn-sm join-item ${filter === "all" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setFilter("all")}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm join-item ${filter === "owned" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setFilter("owned")}
                  >
                    My albums
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm join-item ${filter === "shared" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setFilter("shared")}
                  >
                    Shared with me
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
                      "Could not load albums"}
                  </span>
                </div>
              ) : null}

              {albumsQuery.isLoading ? (
                <div className="flex items-center gap-2 px-1 py-8 text-sm text-base-content/70">
                  <span className="loading loading-spinner loading-sm" />
                  Loading albums...
                </div>
              ) : null}

              {!albumsQuery.isLoading && groups.length === 0 ? (
                <div className="alert alert-info alert-soft text-sm">
                  <span>No albums found for this filter.</span>
                </div>
              ) : null}

              <div className="space-y-6">
                {groups.map((group) => (
                  <section key={group.year}>
                    <h2 className="mb-3 mt-0 text-3xl font-semibold text-base-content">
                      {group.year}{" "}
                      <span className="text-sm font-medium text-base-content/60">
                        ({group.albums.length} albums)
                      </span>
                    </h2>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                      {group.albums.map((album) => (
                        <AlbumCard
                          key={album.id}
                          album={album}
                          isOwned={album.ownerId === session.userId}
                          dateLabel={getAlbumDateLabel(album)}
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

function getAlbumDateLabel(album: AlbumSummary): string {
  const start = formatMonthYear(album.startDate ?? album.createdAt);
  const end = formatMonthYear(album.endDate ?? album.updatedAt);

  if (start && end && start !== end) {
    return `${start} - ${end}`;
  }

  return start ?? end ?? "Unknown date";
}

function formatMonthYear(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleDateString(undefined, {
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

function AlbumDescriptionSection({ description }: AlbumDescriptionSectionProps) {
  const url = extractFirstUrl(description);
  const textWithoutUrl = url ? description.replace(url, "").trim() : description;

  return (
    <div className="mb-4 space-y-3">
      {textWithoutUrl ? (
        <p className="text-sm text-base-content/80 whitespace-pre-wrap">{textWithoutUrl}</p>
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
                {isAdobeUrl(url) ? "View more photos on Lightroom" : url}
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
