import { Archive, ArchiveRestore, Heart } from "lucide-react";
import { Star } from "lucide-react";
import { useState } from "react";
import type { AssetSummary } from "../../types";
import { useI18n } from "../../i18n";

interface FullscreenMetadataBarProps {
  asset: AssetSummary;
  isUpdatingFavorite: boolean;
  isUpdatingArchive: boolean;
  isUpdatingRating: boolean;
  onToggleFavorite: () => void;
  onToggleArchive: () => void;
  onSetRating: (rating: number | null) => void;
}

export function FullscreenMetadataBar({
  asset,
  isUpdatingFavorite,
  isUpdatingArchive,
  isUpdatingRating,
  onToggleFavorite,
  onToggleArchive,
  onSetRating,
}: FullscreenMetadataBarProps) {
  const { t } = useI18n();
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const rating = asset.rating ?? 0;

  console.log("[FullscreenMetadataBar] Asset rating:", {
    assetId: asset.id,
    rating: asset.rating,
    isFavorite: asset.isFavorite,
    isArchived: asset.isArchived,
    hoverRating,
  });

  const displayRating = hoverRating ?? rating;

  return (
    <div className="flex items-center justify-center gap-6 text-white lg:gap-8">
      {/* Star Rating */}
      <div className="join gap-0">
        {[1, 2, 3, 4, 5].map((value) => {
          const isActive = value <= displayRating;
          return (
            <button
              key={value}
              type="button"
              className="btn join-item btn-ghost btn-sm p-1.5 text-white/70 transition-colors"
              onClick={() => onSetRating(value === rating ? null : value)}
              onMouseEnter={() => setHoverRating(value)}
              onMouseLeave={() => setHoverRating(null)}
              disabled={isUpdatingRating}
              aria-label={t("photoGrid.setRatingAria", { value })}
            >
              <Star
                size={14}
                className={
                  isActive ? "fill-warning text-warning" : "text-white/70"
                }
              />
            </button>
          );
        })}
      </div>

      {/* Flags with Tooltips */}
      <div className="join">
        <div
          className="tooltip"
          data-tip={
            asset.isFavorite
              ? t("photoGrid.removeFavorite")
              : t("photoGrid.addFavorite")
          }
        >
          <button
            type="button"
            className="btn join-item btn-ghost btn-sm text-white/80"
            onClick={onToggleFavorite}
            disabled={isUpdatingFavorite}
            aria-label={t("photoGrid.toggleFavoriteAria")}
          >
            <Heart
              size={14}
              className={
                asset.isFavorite ? "fill-error text-error" : "text-white/80"
              }
            />
          </button>
        </div>

        <div
          className="tooltip"
          data-tip={
            asset.isArchived ? t("photoGrid.unarchive") : t("photoGrid.archive")
          }
        >
          <button
            type="button"
            className="btn join-item btn-ghost btn-sm text-white/80"
            onClick={onToggleArchive}
            disabled={isUpdatingArchive}
            aria-label={t("photoGrid.toggleArchiveAria")}
          >
            {asset.isArchived ? (
              <ArchiveRestore size={14} className="text-info" />
            ) : (
              <Archive size={14} className="text-white/80" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
