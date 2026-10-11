import { useQuery } from "@tanstack/react-query";
import { getAssetThumbnail } from "../../api/tauri";
import { useI18n } from "../../i18n";
import type { FixTimeAsset } from "../../types/time";
import { formatAssetDateTime } from "../../utils/timeOffset";

type FixTimeAssetTileProps = {
  asset: FixTimeAsset;
  selected: boolean;
  tone: "primary" | "secondary";
  onSelect: (asset: FixTimeAsset) => void;
};

export function FixTimeAssetTile({ asset, selected, tone, onSelect }: FixTimeAssetTileProps) {
  const { locale } = useI18n();
  const thumbnail = useQuery({
    queryKey: ["fix-time-thumbnail", asset.id],
    queryFn: () => getAssetThumbnail(asset.id),
    staleTime: Infinity,
    retry: false,
  });
  const ring = tone === "primary" ? "border-primary" : "border-secondary";
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={asset.originalFileName}
      onClick={() => onSelect(asset)}
      className={`flex flex-col overflow-hidden rounded-box border-2 bg-base-200 text-left ${
        selected ? ring : "border-transparent hover:border-base-300"
      }`}
    >
      <div className="aspect-square w-full bg-base-300">
        {thumbnail.data && (
          <img src={thumbnail.data} alt="" loading="lazy" className="h-full w-full object-cover" />
        )}
      </div>
      <span
        className={`truncate px-1 py-0.5 text-[11px] ${selected ? "font-semibold" : "opacity-80"}`}
      >
        {formatAssetDateTime(asset.fileCreatedAt, locale)}
      </span>
    </button>
  );
}
