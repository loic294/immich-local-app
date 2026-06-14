import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppTopBar } from "../components/Layout/AppTopBar";
import { PageBackButton } from "../components/Layout/PageBackButton";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { PhotoGrid } from "../components/PhotoGrid/PhotoGrid";
import { useCalendarAssets } from "../hooks/useCalendarAssets";
import {
  addAssetsToAlbum,
  createAlbumWithAssets,
  createShareLinkForAssets,
  fetchAlbums,
  getCachedCalendarFullGridLayout,
  getCachedTimelineMonths,
  updateAssetVisibility,
} from "../api/tauri";
import type { Session } from "../hooks/useSession";

interface CalendarPageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface SelectedMonth {
  year: number;
  month: number; // 1-indexed
}

export function CalendarPage({
  session,
  onNavigate,
  onLogout,
}: CalendarPageProps) {
  const [selected, setSelected] = useState<SelectedMonth | null>(null);

  const timelineQuery = useQuery({
    queryKey: ["timeline-months"],
    queryFn: getCachedTimelineMonths,
    staleTime: 60_000,
  });

  // Group months by year, newest first
  const yearGroups = useMemo(() => {
    const months = timelineQuery.data?.months ?? [];
    const byYear = new Map<number, number[]>();

    for (const key of months) {
      const year = Number.parseInt(key.slice(0, 4), 10);
      const month = Number.parseInt(key.slice(5, 7), 10);
      if (Number.isNaN(year) || Number.isNaN(month)) continue;
      const list = byYear.get(year) ?? [];
      list.push(month);
      byYear.set(year, list);
    }

    return [...byYear.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, monthList]) => ({
        year,
        months: [...monthList].sort((a, b) => b - a),
      }));
  }, [timelineQuery.data]);

  if (selected) {
    return (
      <MonthView
        session={session}
        onNavigate={onNavigate}
        onLogout={onLogout}
        year={selected.year}
        month={selected.month}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="calendar" onNavigate={onNavigate} />

      <section className="flex min-w-0 h-screen flex-col">
        <AppTopBar
          session={session}
          onLogout={onLogout}
          searchInput=""
          onSearchChange={() => {}}
          searchPlaceholder="Calendar"
        />

        <section className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 lg:p-4">
          <h1 className="mb-4 text-2xl font-bold text-base-content">
            Calendar
          </h1>

          {timelineQuery.isError ? (
            <div role="alert" className="alert alert-error alert-soft text-sm">
              <span>
                {(timelineQuery.error as Error | null)?.message ??
                  "Could not load timeline"}
              </span>
            </div>
          ) : null}

          {timelineQuery.isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-base-content/70">
              <span className="loading loading-spinner loading-sm" />
              Loading timeline…
            </div>
          ) : null}

          {!timelineQuery.isLoading && yearGroups.length === 0 ? (
            <div className="alert alert-info alert-soft text-sm">
              <span>No photos found.</span>
            </div>
          ) : null}

          <div className="space-y-8">
            {yearGroups.map(({ year, months }) => (
              <section key={year}>
                <h2 className="mb-3 text-3xl font-semibold text-base-content">
                  {year}
                </h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {months.map((month) => (
                    <button
                      key={month}
                      type="button"
                      onClick={() => setSelected({ year, month })}
                      className="card card-sm bg-base-100 ring-1 ring-base-300/80 shadow-sm text-left transition hover:-translate-y-0.5 hover:shadow-md"
                    >
                      <div className="card-body p-4">
                        <p className="text-base font-semibold text-base-content">
                          {MONTH_NAMES[month - 1]}
                        </p>
                        <p className="text-xs text-base-content/50">{year}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

interface MonthViewProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
  year: number;
  month: number;
  onBack: () => void;
}

function MonthView({
  session,
  onNavigate,
  onLogout,
  year,
  month,
  onBack,
}: MonthViewProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [photoGridHeight, setPhotoGridHeight] = useState(0);
  const [selectedCount, setSelectedCount] = useState(0);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [selectionCommand, setSelectionCommand] = useState<{
    type: "clear" | "select-all";
    nonce: number;
  } | null>(null);

  const assetsQuery = useCalendarAssets(true, year, month);
  const assets = useMemo(
    () => assetsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [assetsQuery.data?.pages],
  );

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
      const title = container.querySelector(
        '[data-test="month-title"]',
      ) as HTMLElement;
      const errorAlert = container.querySelector(
        '[data-test="error-alert"]',
      ) as HTMLElement;

      const padding = 16; // padding from p-2 sm:p-3 lg:p-4 (bottom only)
      let usedHeight = padding;

      if (title) {
        usedHeight += title.offsetHeight + 8; // gap
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
  }, []);

  // Hoisted out of JSX so the hook order stays stable even when the grid is
  // replaced by the error branch (otherwise React throws
  // "Rendered fewer hooks than expected").
  const loadFullLayout = useCallback(
    (containerWidth: number) =>
      getCachedCalendarFullGridLayout(year, month, containerWidth),
    [year, month],
  );

  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="calendar" onNavigate={onNavigate} />

      <section className="flex min-w-0 h-screen flex-col">
        <AppTopBar
          session={session}
          onLogout={onLogout}
          searchInput=""
          onSearchChange={() => {}}
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
            await assetsQuery.refetch();
          }}
          onClearSelection={() => {
            setSelectionCommand({ type: "clear", nonce: Date.now() });
          }}
          onSelectAll={() => {
            setSelectionCommand({ type: "select-all", nonce: Date.now() });
          }}
          searchPlaceholder="Calendar"
        />

        <section
          ref={contentRef}
          className="flex-1 min-h-0 flex flex-col gap-2 p-2 sm:p-3 lg:p-4"
        >
          <div
            data-test="month-title"
            className="mb-1 flex items-center gap-2 shrink-0"
          >
            <PageBackButton ariaLabel="Back" onClick={onBack} />
            <h1 className="m-0 text-xl font-bold text-base-content">
              {MONTH_NAMES[month - 1]} {year}
            </h1>
            {assetsQuery.isSuccess ? (
              <span className="text-sm text-base-content/60">
                ({assets.length} photo{assets.length !== 1 ? "s" : ""})
              </span>
            ) : null}
          </div>

          {assetsQuery.isError && assets.length === 0 ? (
            <div
              role="alert"
              data-test="error-alert"
              className="shrink-0 alert alert-error alert-soft text-sm"
            >
              <span>
                {(assetsQuery.error as Error | null)?.message ??
                  "Could not load photos for this month"}
              </span>
            </div>
          ) : (
            <PhotoGrid
              assets={assets}
              onSelectedCountChange={setSelectedCount}
              onSelectedIdsChange={setSelectedAssetIds}
              selectionCommand={selectionCommand}
              isFetching={assetsQuery.isFetchingNextPage}
              hasNextPage={Boolean(assetsQuery.hasNextPage)}
              maxHeight={photoGridHeight}
              onLoadMore={() =>
                assetsQuery.fetchNextPage().then(() => undefined)
              }
              loadFullLayout={loadFullLayout}
            />
          )}
        </section>
      </section>
    </main>
  );
}
