import type { AssetStateStatus } from "../../hooks/useAssetState";
import { getStatusBadgeContent } from "./assetStatusBadge.utils";
import { useI18n } from "../../i18n";

interface AssetStatusBadgeProps {
  assetState: AssetStateStatus;
  onDownloadClick?: () => void;
  downloadProgress?: number | null;
  shareProgress?: number | null;
  className?: string;
}

/**
 * Status badge for fullscreen image/video viewer.
 * Displays current asset state (loading, cached, offline, etc.) with:
 * - Colored status icon (left)
 * - Bold title text (top-right)
 * - Smaller subtitle (bottom-right)
 * - Optional progress bar for video downloads
 *
 * Click handler is only active if the badge content is clickable.
 */
export function AssetStatusBadge({
  assetState,
  onDownloadClick,
  downloadProgress = null,
  shareProgress = null,
  className = "",
}: AssetStatusBadgeProps) {
  const { t } = useI18n();

  const badgeContent = getStatusBadgeContent(assetState, t);

  if (!badgeContent) {
    return null;
  }

  const Icon = badgeContent.icon;
  const isClickable = badgeContent.isClickable;

  const handleClick = () => {
    if (isClickable && onDownloadClick) {
      onDownloadClick();
    }
  };

  return (
    <button
      type="button"
      disabled={!isClickable || downloadProgress !== null || shareProgress !== null}
      onClick={handleClick}
      className={`
        relative flex items-center gap-3 rounded-box px-3 py-2 text-left
        bg-zinc-900 text-white border border-white/15
        ${isClickable && downloadProgress === null && shareProgress === null ? "cursor-pointer hover:bg-zinc-800 transition-colors" : "cursor-default opacity-90"}
        ${className}
      `}
    >
      <div className={`shrink-0 flex items-center justify-center size-7 ${badgeContent.iconColor}`}>
        <Icon size={22} aria-hidden="true" />
      </div>

      {/* Text content */}
      <div className="flex flex-col items-start gap-1 min-w-0">
        <div className="text-sm font-semibold text-white leading-snug">{badgeContent.title}</div>
        <div className="text-xs text-white/70 leading-relaxed">{badgeContent.subtitle}</div>
      </div>

      {/* Progress bar for videos, downloads, share, and full-res zoom */}
      {(downloadProgress !== null ||
        shareProgress !== null ||
        assetState.videoDownloadProgress !== null ||
        assetState.fullResDownloadProgress !== null) && (
        <div className="absolute bottom-0 left-2 right-2 h-1 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-white/70 transition-all duration-300"
            style={{
              width: `${downloadProgress ?? shareProgress ?? assetState.videoDownloadProgress ?? assetState.fullResDownloadProgress ?? 0}%`,
            }}
          />
        </div>
      )}
    </button>
  );
}
