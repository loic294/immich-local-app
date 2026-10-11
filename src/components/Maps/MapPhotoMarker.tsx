import { useQuery } from "@tanstack/react-query";
import { Image } from "lucide-react";
import { getAssetThumbnail } from "../../api/tauri";
import { useBrowsingI18n } from "../../i18n/browsing";

interface MapPhotoMarkerProps {
  assetId: string;
  count: number;
  onClick: () => void;
}

export function MapPhotoMarker({ assetId, count, onClick }: MapPhotoMarkerProps) {
  const t = useBrowsingI18n();
  const thumbnail = useQuery({
    queryKey: ["map-thumbnail", assetId],
    queryFn: () => getAssetThumbnail(assetId),
    staleTime: Infinity,
    retry: false,
  });
  return (
    <button
      type="button"
      className="relative h-14 w-14 rounded-lg border-2 border-primary bg-base-100 shadow-lg transition-transform hover:scale-110"
      aria-label={`${count} ${t("photos")}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {thumbnail.data ? (
        <img src={thumbnail.data} alt="" className="h-full w-full rounded-md object-cover" />
      ) : (
        <Image size={24} className="mx-auto text-base-content/60" />
      )}
      {count > 1 ? (
        <span className="badge badge-primary badge-sm absolute -right-2 -top-2">{count}</span>
      ) : null}
    </button>
  );
}
