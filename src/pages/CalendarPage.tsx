import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { Header } from "../components/Layout/Header";
import { Sidebar, type AppPage } from "../components/Layout/Sidebar";
import { PhotoGrid } from "../components/PhotoGrid/PhotoGrid";
import { useCalendarAssets } from "../hooks/useCalendarAssets";
import { fetchTimelineMonths } from "../api/tauri";
import type { Session } from "../hooks/useSession";

interface CalendarPageProps {
  session: Session;
  onNavigate: (page: AppPage) => void;
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

export function CalendarPage({ session, onNavigate }: CalendarPageProps) {
  const [selected, setSelected] = useState<SelectedMonth | null>(null);

  const timelineQuery = useQuery({
    queryKey: ["timeline-months"],
    queryFn: fetchTimelineMonths,
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
        <Header
          searchInput=""
          onSearchChange={() => {}}
          serverUrl={session.serverUrl}
          userId={session.userId}
          userName={session.userName}
          searchPlaceholder="Calendar"
        />

        <section className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 lg:p-4">
          <h1 className="mb-4 text-xl font-bold text-base-content">Calendar</h1>

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
  year: number;
  month: number;
  onBack: () => void;
}

function MonthView({
  session,
  onNavigate,
  year,
  month,
  onBack,
}: MonthViewProps) {
  const assetsQuery = useCalendarAssets(true, year, month);
  const assets = useMemo(
    () => assetsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [assetsQuery.data?.pages],
  );

  return (
    <main className="min-h-screen bg-base-200 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar activePage="calendar" onNavigate={onNavigate} />

      <section className="flex min-w-0 h-screen flex-col">
        <Header
          searchInput=""
          onSearchChange={() => {}}
          serverUrl={session.serverUrl}
          userId={session.userId}
          userName={session.userName}
          searchPlaceholder="Calendar"
        />

        <section className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 lg:p-4">
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onBack}
            >
              <ChevronLeft size={16} />
              Back
            </button>
            <h1 className="m-0 text-lg font-bold text-base-content">
              {MONTH_NAMES[month - 1]} {year}
            </h1>
            {assetsQuery.isSuccess ? (
              <span className="text-sm text-base-content/60">
                ({assets.length} photo{assets.length !== 1 ? "s" : ""})
              </span>
            ) : null}
          </div>

          {assetsQuery.isError ? (
            <div role="alert" className="alert alert-error alert-soft text-sm">
              <span>
                {(assetsQuery.error as Error | null)?.message ??
                  "Could not load photos for this month"}
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
    </main>
  );
}
