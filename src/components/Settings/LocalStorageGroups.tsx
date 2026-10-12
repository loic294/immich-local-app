import { useState } from "react";
import { Folder, Images, Trash2 } from "lucide-react";
import { useLocalStorageGroups } from "../../hooks/useLocalStorageGroups";
import type { LocalStorageGroup, LocalStorageRemovalPreview } from "../../types/storage";
import { useI18n } from "../../i18n";
import { StorageConfirmationDialog } from "./StorageConfirmationDialog";
import { formatStorageBytes } from "../../utils/storage";

export function LocalStorageGroups() {
  const { t } = useI18n();
  const { groups, prepare, remove } = useLocalStorageGroups();
  const [confirmation, setConfirmation] = useState<{
    group: LocalStorageGroup;
    preview: LocalStorageRemovalPreview;
  } | null>(null);
  const name = (group: LocalStorageGroup) =>
    group.albumId === null ? t("settings.storageTimeline") : group.name;
  const busy = prepare.isPending || remove.isPending;
  return (
    <section className="mt-4 border-t border-base-300 pt-4">
      <h3 className="font-semibold">{t("settings.localCopies")}</h3>
      <p className="mt-1 text-sm text-base-content/70">{t("settings.localCopiesHelp")}</p>
      {groups.isPending && (
        <span
          className="loading loading-spinner loading-sm mt-3"
          aria-label={t("settings.storageMeasuring")}
        />
      )}
      {[groups.error, prepare.error, remove.error].filter(Boolean).map((error, index) => (
        <p key={index} role="alert" className="mt-2 text-sm text-error">
          {String(error)}
        </p>
      ))}
      <ul className="list mt-3">
        {groups.data?.map((group) => (
          <li key={group.albumId ?? "timeline"} className="list-row items-center px-0">
            {group.albumId === null ? (
              <Images className="text-secondary" size={22} aria-hidden="true" />
            ) : (
              <Folder className="text-primary" size={22} aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p className="break-words font-medium">{name(group)}</p>
              <p className="text-sm text-base-content/60">
                {t("settings.localCopyFiles", { count: group.fileCount })}
              </p>
              {group.folderPath && (
                <p className="break-all text-xs text-base-content/60">{group.folderPath}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <span className="font-mono text-sm">{formatStorageBytes(group.bytes)}</span>
              <button
                type="button"
                className="btn btn-sm btn-outline btn-error"
                disabled={busy}
                aria-label={t("settings.deleteLocalCopiesFor", { name: name(group) })}
                onClick={async () => {
                  remove.reset();
                  try {
                    const preview = await prepare.mutateAsync(group.albumId);
                    setConfirmation({ group, preview });
                  } catch (error) {
                    console.error("[storage.local] preparation failed", error);
                  }
                }}
              >
                {prepare.isPending && prepare.variables === group.albumId ? (
                  <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                ) : (
                  <Trash2 size={16} aria-hidden="true" />
                )}
                {t("settings.deleteLocalCopies")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-ghost btn-sm mt-2"
        disabled={busy || groups.isFetching}
        onClick={() => void groups.refetch()}
      >
        {t("settings.refreshLocalCopies")}
      </button>
      {prepare.isPending && (
        <p role="status" className="text-sm">
          {t("settings.checkingLocalBackups")}
        </p>
      )}
      {remove.isSuccess && (
        <p role="status" className="mt-2 text-sm text-success">
          {t("settings.localCopiesRemoved", { count: remove.data })}
        </p>
      )}
      {confirmation && (
        <StorageConfirmationDialog
          title={t("settings.deleteLocalCopiesFor", { name: name(confirmation.group) })}
          description={t("settings.deleteLocalCopiesConfirm", {
            count: confirmation.preview.fileCount,
          })}
          warning={
            confirmation.preview.unverifiedCount > 0
              ? t("settings.localBackupsUnverified", {
                  count: confirmation.preview.unverifiedCount,
                })
              : undefined
          }
          busy={remove.isPending}
          onClose={() => setConfirmation(null)}
          onConfirm={() =>
            remove.mutate(confirmation.preview, {
              onSettled: () => setConfirmation(null),
            })
          }
        />
      )}
    </section>
  );
}
