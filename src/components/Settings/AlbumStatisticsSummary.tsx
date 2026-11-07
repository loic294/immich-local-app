import { Album, ImageOff, Images } from "lucide-react";
import type { AlbumStatisticsLabels } from "../../i18n/albumStatistics";
import type { AlbumStatistics } from "../../types/albumStatistics";
import { formatCount, formatPercent, ratioOf, totalAssets } from "../../utils/albumStatistics";

interface AlbumStatisticsSummaryProps {
  stats: AlbumStatistics;
  labels: AlbumStatisticsLabels;
  locale: string;
}

export function AlbumStatisticsSummary({ stats, labels, locale }: AlbumStatisticsSummaryProps) {
  const library = totalAssets(stats);
  const count = (value: number) => formatCount(value, locale);
  const share = (value: number) => labels.ofLibrary(formatPercent(ratioOf(value, library), locale));

  return (
    <div className="stats stats-vertical w-full border border-base-300 @2xl:stats-horizontal">
      <div className="stat">
        <div className="stat-figure text-base-content/60">
          <Album size={28} aria-hidden="true" />
        </div>
        <div className="stat-title">{labels.albums}</div>
        <div className="stat-value text-3xl tabular-nums">{count(stats.albumCount)}</div>
        <div className="stat-desc">
          {labels.shared(stats.sharedAlbumCount, count(stats.sharedAlbumCount))}
        </div>
      </div>
      <div className="stat">
        <div className="stat-figure text-primary">
          <Images size={28} aria-hidden="true" />
        </div>
        <div className="stat-title">{labels.inAlbums}</div>
        <div className="stat-value text-3xl text-primary tabular-nums">
          {count(stats.assetsInAlbums)}
        </div>
        <div className="stat-desc">{share(stats.assetsInAlbums)}</div>
      </div>
      <div className="stat">
        <div className="stat-figure text-secondary">
          <ImageOff size={28} aria-hidden="true" />
        </div>
        <div className="stat-title">{labels.notInAlbums}</div>
        <div className="stat-value text-3xl text-secondary tabular-nums">
          {count(stats.assetsNotInAlbums)}
        </div>
        <div className="stat-desc">{share(stats.assetsNotInAlbums)}</div>
      </div>
    </div>
  );
}
