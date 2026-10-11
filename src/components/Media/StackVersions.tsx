import { useQuery } from "@tanstack/react-query";
import { getEditVersions } from "../../api/media";
import { getAssetThumbnail } from "../../api/tauri";
import { useMediaLabels } from "../../i18n/media";

interface StackVersionsProps {
  assetId: string;
}
function VersionThumbnail({ assetId }: StackVersionsProps) {
  const thumbnail = useQuery({
    queryKey: ["version-thumbnail", assetId],
    queryFn: () => getAssetThumbnail(assetId),
    staleTime: Infinity,
  });
  return (
    <div className="aspect-square bg-base-300">
      {thumbnail.data && <img src={thumbnail.data} alt="" className="h-full w-full object-cover" />}
      {thumbnail.isError && <span title={String(thumbnail.error)}>!</span>}
    </div>
  );
}
export function StackVersions({ assetId }: StackVersionsProps) {
  const labels = useMediaLabels();
  const versions = useQuery({
    queryKey: ["edit-versions", assetId],
    queryFn: () => getEditVersions(assetId),
  });
  if (versions.isError)
    return (
      <p role="alert" className="text-error">
        {String(versions.error)}
      </p>
    );
  if (!versions.data?.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">{labels.versions}</h3>
      <div className="flex flex-wrap gap-2">
        {versions.data.map((asset, index) => (
          <button
            key={asset.id}
            type="button"
            className={`w-16 overflow-hidden rounded-box border-2 ${asset.id === assetId ? "border-primary" : "border-base-300"}`}
            title={`${index === versions.data.length - 1 ? labels.original : labels.version}: ${asset.originalFileName}`}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("media:open-version", { detail: { assetId: asset.id } }),
              )
            }
          >
            <VersionThumbnail assetId={asset.id} />
          </button>
        ))}
      </div>
    </section>
  );
}
