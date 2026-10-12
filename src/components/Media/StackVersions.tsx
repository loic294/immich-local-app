import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { deleteEditVersion, getEditVersions } from "../../api/media";
import { getAssetThumbnail } from "../../api/tauri";
import { useMediaLabels } from "../../i18n/media";
import { useI18n } from "../../i18n";
import { useSettings } from "../../hooks/useSettings";
import type { AssetSummary } from "../../types";

interface StackVersionsProps {
  assetId: string;
}
function VersionThumbnail({ assetId }: { assetId: string }) {
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
function VersionCard({
  asset,
  assetId,
  original,
  remainingCount,
}: {
  asset: AssetSummary;
  assetId: string;
  original: AssetSummary;
  remainingCount: number;
}) {
  const labels = useMediaLabels();
  const { t } = useI18n();
  const { data: settings } = useSettings();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [queued, setQueued] = useState(false);
  const deletion = useMutation({
    mutationFn: () => deleteEditVersion(asset.id),
    onSuccess: async (wasQueued) => {
      setQueued(wasQueued);
      setConfirming(false);
      console.info(`[media:versions] deleted asset=${asset.id} queued=${wasQueued}`);
      window.dispatchEvent(
        new CustomEvent("media:versions-changed", {
          detail: { deletedAssetId: asset.id, sourceAssetId: assetId, original, remainingCount },
        }),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["edit-versions"] }),
        queryClient.invalidateQueries({ queryKey: ["assets"] }),
        queryClient.invalidateQueries({ queryKey: ["album-assets-paged"] }),
        queryClient.invalidateQueries({ queryKey: ["folder-assets-paged"] }),
        queryClient.invalidateQueries({ queryKey: ["calendar-assets-paged"] }),
      ]);
    },
    onError: (error) => console.error(`[media:versions] delete failed asset=${asset.id}`, error),
  });
  const isOriginal = asset.id === original.id;
  const canDelete = !isOriginal;
  return (
    <div className="w-20 space-y-1">
      <div
        className={`relative overflow-hidden rounded-box border-2 ${asset.id === assetId ? "border-primary" : "border-base-300"}`}
      >
        <button
          type="button"
          className="block w-full"
          title={`${isOriginal ? labels.original : labels.version}: ${asset.originalFileName}`}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("media:open-version", {
                detail: { assetId: asset.id, sourceAssetId: assetId, asset, original },
              }),
            )
          }
        >
          <VersionThumbnail assetId={asset.id} />
        </button>
        {canDelete && (
          <button
            type="button"
            className="btn btn-circle btn-xs btn-error absolute right-1 top-1"
            aria-label={`${labels.deleteVersion}: ${asset.originalFileName}`}
            title={labels.deleteVersion}
            onClick={() => setConfirming(true)}
          >
            ×
          </button>
        )}
      </div>
      {queued && (
        <p role="status" className="text-xs text-warning">
          {labels.queuedDeleteVersion}
        </p>
      )}
      {deletion.isError && (
        <p role="alert" className="text-xs text-error">
          {labels.deleteVersionFailed}
        </p>
      )}
      {confirming && (
        <dialog
          className="modal modal-open"
          open
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`delete-version-${asset.id}`}
          onCancel={(event) => {
            event.preventDefault();
            setConfirming(false);
          }}
        >
          <div className="modal-box text-base-content">
            <h3 id={`delete-version-${asset.id}`} className="font-bold">
              {labels.deleteVersion}
            </h3>
            <p className="py-4">
              {t(
                settings?.deleteBehavior === "trash"
                  ? "settings.deleteVersionTrashConfirm"
                  : "settings.deleteVersionArchiveConfirm",
              )}
            </p>
            <div className="modal-action">
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                {labels.cancel}
              </button>
              <button
                type="button"
                className="btn btn-error"
                disabled={deletion.isPending}
                onClick={() => deletion.mutate()}
              >
                {deletion.isPending ? (
                  <span className="loading loading-spinner loading-sm" />
                ) : (
                  labels.deleteVersion
                )}
              </button>
            </div>
          </div>
          <button
            className="modal-backdrop"
            type="button"
            aria-label={labels.cancel}
            onClick={() => setConfirming(false)}
          />
        </dialog>
      )}
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
    <section className="mt-3 space-y-2">
      <h3 className="font-semibold">{labels.versions}</h3>
      <div className="flex flex-wrap gap-2">
        {versions.data.map((asset) => (
          <VersionCard
            key={asset.id}
            asset={asset}
            assetId={assetId}
            original={versions.data[versions.data.length - 1]}
            remainingCount={versions.data.length - 1}
          />
        ))}
      </div>
    </section>
  );
}
