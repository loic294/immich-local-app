import { Info, RefreshCcw } from "lucide-react";
import { useId, useMemo } from "react";
import type { Account } from "../../api/tauri";
import { useAlbumStatistics } from "../../hooks/useAlbumStatistics";
import { useI18n } from "../../i18n";
import { useAlbumStatisticsLabels } from "../../i18n/albumStatistics";
import { buildAccountRows, formatCount, totalAssets } from "../../utils/albumStatistics";
import { AlbumAccountBreakdown } from "./AlbumAccountBreakdown";
import { AlbumStatisticsCharts } from "./AlbumStatisticsCharts";
import { AlbumStatisticsSummary } from "./AlbumStatisticsSummary";

interface AlbumStatisticsCardProps {
  accounts: Account[];
}

export function AlbumStatisticsCard({ accounts }: AlbumStatisticsCardProps) {
  const labels = useAlbumStatisticsLabels();
  const { locale } = useI18n();
  const statistics = useAlbumStatistics();
  const titleId = useId();
  const stats = statistics.data;
  const rows = useMemo(
    () => (stats ? buildAccountRows(stats, accounts, labels.unknownAccount) : []),
    [stats, accounts, labels.unknownAccount],
  );
  const isEmpty = stats !== undefined && stats.albumCount === 0 && totalAssets(stats) === 0;

  return (
    <section
      className="card mb-6 border border-base-300 bg-base-100 shadow-sm"
      aria-labelledby={titleId}
    >
      <div className="card-body @container gap-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="card-title">
              {labels.title}
            </h2>
            <p className="text-sm text-base-content/70">{labels.description}</p>
          </div>
          <button
            type="button"
            className="btn btn-square btn-ghost btn-sm"
            onClick={() => void statistics.refetch()}
            disabled={statistics.isFetching}
            aria-label={labels.refresh}
            title={labels.refresh}
          >
            {statistics.isFetching ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : (
              <RefreshCcw size={16} aria-hidden="true" />
            )}
          </button>
        </div>
        {statistics.isError && (
          <div role="alert" className="alert alert-error alert-soft text-sm">
            <span>{labels.loadFailed}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void statistics.refetch()}
              disabled={statistics.isFetching}
            >
              {labels.retry}
            </button>
          </div>
        )}
        {statistics.isPending && (
          <div role="status" className="flex flex-col gap-4">
            <span className="sr-only">{labels.loading}</span>
            <div className="skeleton h-24 w-full" />
            <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
              <div className="skeleton h-64" />
              <div className="skeleton h-64" />
            </div>
          </div>
        )}
        {isEmpty && <p className="text-sm text-base-content/70">{labels.empty}</p>}
        {stats && !isEmpty && (
          <>
            <AlbumStatisticsSummary stats={stats} labels={labels} locale={locale} />
            {stats.unsyncedAlbumCount > 0 && (
              <div role="status" className="alert alert-info alert-soft text-sm">
                <Info size={18} aria-hidden="true" />
                <span>
                  {labels.unsynced(
                    stats.unsyncedAlbumCount,
                    formatCount(stats.unsyncedAlbumCount, locale),
                  )}
                </span>
              </div>
            )}
            <AlbumStatisticsCharts stats={stats} rows={rows} labels={labels} locale={locale} />
            <AlbumAccountBreakdown rows={rows} labels={labels} locale={locale} />
          </>
        )}
      </div>
    </section>
  );
}
