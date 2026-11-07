import type { AlbumStatisticsLabels } from "../../i18n/albumStatistics";
import {
  ALBUM_COVERAGE_COLORS,
  formatCount,
  formatPercent,
  ratioOf,
  type AccountStatisticsRow,
} from "../../utils/albumStatistics";
import { StackedBar } from "../Charts/StackedBar";

interface AlbumAccountBreakdownProps {
  rows: AccountStatisticsRow[];
  labels: AlbumStatisticsLabels;
  locale: string;
}

export function AlbumAccountBreakdown({ rows, labels, locale }: AlbumAccountBreakdownProps) {
  if (rows.length === 0) return null;
  const count = (value: number) => formatCount(value, locale);

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{labels.breakdownTitle}</h3>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const inLabel = `${labels.inAlbums}: ${count(row.assetsInAlbums)} · ${formatPercent(ratioOf(row.assetsInAlbums, row.totalAssets), locale)}`;
          const outLabel = `${labels.notInAlbums}: ${count(row.assetsNotInAlbums)} · ${formatPercent(ratioOf(row.assetsNotInAlbums, row.totalAssets), locale)}`;
          return (
            <li
              key={row.accountId}
              className="flex flex-col gap-2 rounded-box border border-base-300 p-3"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  aria-hidden="true"
                  className={`h-3 w-3 shrink-0 rounded-full ${row.color.bg}`}
                />
                <span className="min-w-0 truncate font-medium">{row.label}</span>
                {row.serverUrl && (
                  <span className="min-w-0 truncate text-xs text-base-content/60">
                    {row.serverUrl}
                  </span>
                )}
                <span className="ml-auto flex flex-wrap gap-1">
                  <span className="badge badge-sm badge-ghost">
                    {labels.albumCount(row.albumCount, count(row.albumCount))}
                  </span>
                  {row.sharedAlbumCount > 0 && (
                    <span className="badge badge-sm badge-outline">
                      {labels.shared(row.sharedAlbumCount, count(row.sharedAlbumCount))}
                    </span>
                  )}
                  <span className="badge badge-sm badge-ghost">
                    {labels.photoCount(row.totalAssets, count(row.totalAssets))}
                  </span>
                </span>
              </div>
              {row.totalAssets > 0 ? (
                <>
                  <StackedBar
                    ariaLabel={`${row.label}: ${inLabel}, ${outLabel}`}
                    segments={[
                      {
                        key: "in",
                        value: row.assetsInAlbums,
                        label: inLabel,
                        colorClass: ALBUM_COVERAGE_COLORS.inAlbums.bg,
                      },
                      {
                        key: "out",
                        value: row.assetsNotInAlbums,
                        label: outLabel,
                        colorClass: ALBUM_COVERAGE_COLORS.notInAlbums.bg,
                      },
                    ]}
                  />
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-base-content/70 tabular-nums">
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 rounded-full ${ALBUM_COVERAGE_COLORS.inAlbums.bg}`}
                      />
                      {inLabel}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 rounded-full ${ALBUM_COVERAGE_COLORS.notInAlbums.bg}`}
                      />
                      {outLabel}
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-xs text-base-content/60">{labels.noPhotos}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
