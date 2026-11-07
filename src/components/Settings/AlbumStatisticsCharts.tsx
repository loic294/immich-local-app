import type { AlbumStatisticsLabels } from "../../i18n/albumStatistics";
import type { AlbumStatistics } from "../../types/albumStatistics";
import {
  ALBUM_COVERAGE_COLORS,
  formatCount,
  formatPercent,
  ratioOf,
  totalAssets,
  type AccountStatisticsRow,
} from "../../utils/albumStatistics";
import { ChartLegend, type ChartLegendItem } from "../Charts/ChartLegend";
import { DonutChart } from "../Charts/DonutChart";

interface AlbumStatisticsChartsProps {
  stats: AlbumStatistics;
  rows: AccountStatisticsRow[];
  labels: AlbumStatisticsLabels;
  locale: string;
}

function describe(title: string, items: ChartLegendItem[]): string {
  const parts = items.map((item) =>
    item.detail ? `${item.label} ${item.value} (${item.detail})` : `${item.label} ${item.value}`,
  );
  return `${title}: ${parts.join(", ")}`;
}

export function AlbumStatisticsCharts({ stats, rows, labels, locale }: AlbumStatisticsChartsProps) {
  const library = totalAssets(stats);
  const percent = (part: number, total: number) => formatPercent(ratioOf(part, total), locale);

  const coverageItems: ChartLegendItem[] = [
    {
      key: "in",
      label: labels.inAlbums,
      value: formatCount(stats.assetsInAlbums, locale),
      detail: percent(stats.assetsInAlbums, library),
      swatchClass: ALBUM_COVERAGE_COLORS.inAlbums.bg,
    },
    {
      key: "out",
      label: labels.notInAlbums,
      value: formatCount(stats.assetsNotInAlbums, locale),
      detail: percent(stats.assetsNotInAlbums, library),
      swatchClass: ALBUM_COVERAGE_COLORS.notInAlbums.bg,
    },
  ];
  const accountItems: ChartLegendItem[] = rows.map((row) => ({
    key: row.accountId,
    label: row.label,
    value: formatCount(row.albumCount, locale),
    detail: percent(row.albumCount, stats.albumCount),
    swatchClass: row.color.bg,
  }));

  return (
    <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
      <section className="flex flex-col items-center gap-4 rounded-box border border-base-300 p-4">
        <h3 className="self-start text-sm font-semibold">{labels.coverageTitle}</h3>
        <DonutChart
          ariaLabel={describe(labels.coverageTitle, coverageItems)}
          centerValue={percent(stats.assetsInAlbums, library)}
          centerCaption={labels.coverageCaption}
          segments={[
            {
              key: "in",
              value: stats.assetsInAlbums,
              label: coverageItems[0].label,
              colorClass: ALBUM_COVERAGE_COLORS.inAlbums.text,
            },
            {
              key: "out",
              value: stats.assetsNotInAlbums,
              label: coverageItems[1].label,
              colorClass: ALBUM_COVERAGE_COLORS.notInAlbums.text,
            },
          ]}
        />
        <ChartLegend items={coverageItems} />
      </section>
      <section className="flex flex-col items-center gap-4 rounded-box border border-base-300 p-4">
        <h3 className="self-start text-sm font-semibold">{labels.albumsByAccountTitle}</h3>
        <DonutChart
          ariaLabel={describe(labels.albumsByAccountTitle, accountItems)}
          centerValue={formatCount(stats.albumCount, locale)}
          centerCaption={labels.albumsCaption}
          segments={rows.map((row) => ({
            key: row.accountId,
            value: row.albumCount,
            label: `${row.label}: ${formatCount(row.albumCount, locale)}`,
            colorClass: row.color.text,
          }))}
        />
        {stats.albumCount === 0 && (
          <p className="text-sm text-base-content/60">{labels.noAlbums}</p>
        )}
        <ChartLegend items={accountItems} />
      </section>
    </div>
  );
}
