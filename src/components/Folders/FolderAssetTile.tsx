import { useEffect, useState } from "react";
import { getAssetThumbnail } from "../../api/tauri";
import type { AssetSummary } from "../../types";

interface FolderAssetTileProps {
  asset: AssetSummary;
}

export function FolderAssetTile({ asset }: FolderAssetTileProps) {
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
    <article className="group overflow-hidden rounded-xl bg-base-100 ring-1 ring-base-300/90">
      <div className="aspect-square bg-base-200">
        {src ? (
          <img
            src={src}
            alt={asset.originalFileName}
            className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-base-content/50">
            Loading
          </div>
        )}
      </div>
      <div className="truncate px-2 py-1 text-xs text-base-content/70">
        {asset.originalFileName}
      </div>
    </article>
  );
}
