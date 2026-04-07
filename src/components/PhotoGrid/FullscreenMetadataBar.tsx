import { Archive, ArchiveRestore, Heart } from "lucide-react";
import { Star } from "lucide-react";
import { useState } from "react";
import type { AssetSummary } from "../../types";

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
    <div className="rounded-2xl border border-white/10 bg-black/45 px-3 py-2 text-white backdrop-blur-md">
      <div className="flex items-center justify-center gap-6 lg:gap-8">
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
                aria-label={`Set rating to ${value}`}
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
            data-tip={asset.isFavorite ? "Remove favorite" : "Add to favorites"}
          >
            <button
              type="button"
              className="btn join-item btn-ghost btn-sm text-white/80"
              onClick={onToggleFavorite}
              disabled={isUpdatingFavorite}
              aria-label="Toggle favorite"
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
            data-tip={asset.isArchived ? "Unarchive" : "Archive"}
          >
            <button
              type="button"
              className="btn join-item btn-ghost btn-sm text-white/80"
              onClick={onToggleArchive}
              disabled={isUpdatingArchive}
              aria-label="Toggle archive"
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
    </div>
  );
}
