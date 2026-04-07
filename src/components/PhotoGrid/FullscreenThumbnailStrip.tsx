import * as React from "react";
import { useEffect, useState } from "react";
import { CirclePlay, Film } from "lucide-react";
import { getAssetThumbnail } from "../../api/tauri";
import type { AssetSummary } from "../../types";

interface FullscreenThumbnailStripProps {
  assets: AssetSummary[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

interface ThumbnailButtonProps {
  asset: AssetSummary;
  isActive: boolean;
  onClick: () => void;
}

const ThumbnailButton = React.forwardRef<
  HTMLButtonElement,
  ThumbnailButtonProps
>(({ asset, isActive, onClick }, ref) => {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadThumbnail() {
      try {
        const value = await getAssetThumbnail(asset.id);
        if (!cancelled) {
          setSrc(value);
        }
      } catch {
        if (!cancelled) {
          setSrc(null);
        }
      }
    }

    void loadThumbnail();

    return () => {
      cancelled = true;
    };
  }, [asset.id]);

  return (
    <button
      ref={ref}
      type="button"
      className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border transition-all ${
        isActive
          ? "border-primary ring-2 ring-primary/70"
          : "border-white/15 hover:border-white/40"
      }`}
      onClick={onClick}
      aria-label={`Open ${asset.originalFileName}`}
    >
      {src ? (
        <img
          className="h-full w-full object-cover"
          src={src}
          alt={asset.originalFileName}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-white/10">
          <span className="loading loading-spinner loading-xs text-white" />
        </div>
      )}

      {asset.livePhotoVideoId ? (
        <div className="absolute right-1 top-1 rounded-md bg-black/60 p-1 text-white">
          <Film size={10} />
        </div>
      ) : null}

      {isVideoAsset(asset) ? (
        <div className="absolute bottom-1 right-1 rounded-md bg-black/60 p-1 text-white">
          <CirclePlay size={10} />
        </div>
      ) : null}
    </button>
  );
});

ThumbnailButton.displayName = "ThumbnailButton";

export function FullscreenThumbnailStrip({
  assets,
  activeIndex,
  onSelect,
}: FullscreenThumbnailStripProps) {
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const activeThumbnailRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (!activeThumbnailRef.current || !scrollContainerRef.current) {
      return;
    }

    const scrollContainer = scrollContainerRef.current;
    const activeThumbnail = activeThumbnailRef.current;
    const containerRect = scrollContainer.getBoundingClientRect();
    const thumbRect = activeThumbnail.getBoundingClientRect();

    if (
      thumbRect.left < containerRect.left ||
      thumbRect.right > containerRect.right
    ) {
      const scrollLeft =
        activeThumbnail.offsetLeft +
        activeThumbnail.offsetWidth / 2 -
        scrollContainer.clientWidth / 2;

      scrollContainer.scrollTo({
        left: Math.max(0, scrollLeft),
        behavior: "smooth",
      });
    }
  }, [activeIndex]);

  return (
    <div
      ref={scrollContainerRef}
      className="horizontal-scrollbar overflow-x-auto"
    >
      <div className="flex gap-2">
        {assets.map((asset, index) => (
          <ThumbnailButton
            key={asset.id}
            asset={asset}
            isActive={index === activeIndex}
            onClick={() => onSelect(index)}
            ref={index === activeIndex ? activeThumbnailRef : null}
          />
        ))}
      </div>
    </div>
  );
}

function isVideoAsset(asset: AssetSummary): boolean {
  if ((asset.type ?? "").toUpperCase() === "VIDEO") {
    return true;
  }

  const name = asset.originalFileName.toLowerCase();
  return /(\.mp4|\.mov|\.webm|\.mkv|\.avi|\.m4v)$/.test(name);
}
