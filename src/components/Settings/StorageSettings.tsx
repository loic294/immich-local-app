import { useEffect, useState } from "react";
import { useStorageSettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import type { VideoQuality } from "../../types/storage";
import { LocalStorageGroups } from "./LocalStorageGroups";
import { StorageConfirmationDialog } from "./StorageConfirmationDialog";
import { formatStorageBytes as formatBytes } from "../../utils/storage";

interface StorageSettingsProps {
  section: "storage" | "video";
}

export function StorageSettings({ section }: StorageSettingsProps) {
  const { t } = useI18n();
  const { preferences, storage, videoOptions, save, clear } = useStorageSettings();
  const [limitGiB, setLimitGiB] = useState("");
  const [inputError, setInputError] = useState("");
  const [confirmCacheRemoval, setConfirmCacheRemoval] = useState(false);
  useEffect(() => {
    if (preferences.data) setLimitGiB(String(preferences.data.maxCacheBytes / 1024 ** 3));
  }, [preferences.data?.maxCacheBytes]);
  const errors = [preferences.error, storage.error, save.error, clear.error, inputError].filter(
    Boolean,
  );
  const current = preferences.data;
  const summary = storage.data;
  const saveQuality = (
    field: "streamingVideoQuality" | "offlineVideoQuality",
    value: VideoQuality,
  ) => {
    if (current) save.mutate({ ...current, [field]: value });
  };
  const segments = summary
    ? [
        {
          label: t("settings.storageCache"),
          bytes: summary.cacheOnLibraryVolume ? summary.cacheBytes : 0,
          color: "bg-primary",
        },
        {
          label: t("settings.storageOffline"),
          bytes: summary.diskOfflineBytes,
          color: "bg-secondary",
        },
        {
          label: t("settings.storagePending"),
          bytes: summary.diskPendingUploadBytes,
          color: "bg-accent",
        },
        { label: t("settings.storageOther"), bytes: summary.otherUsedBytes, color: "bg-neutral" },
        {
          label: t("settings.storageFree"),
          bytes: summary.diskAvailableBytes,
          color: "bg-base-300",
        },
      ]
    : [];

  return (
    <section className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body">
        <h2 className="card-title">
          {t(section === "storage" ? "settings.sectionStorage" : "settings.sectionVideo")}
        </h2>
        {errors.map((error, index) => (
          <p role="alert" className="text-sm text-error" key={index}>
            {String(error)}
          </p>
        ))}
        {section === "storage" ? (
          <>
            {storage.isPending && (
              <span
                className="loading loading-spinner"
                aria-label={t("settings.storageMeasuring")}
              />
            )}
            {summary && (
              <>
                <p className="break-all text-sm text-base-content/60">
                  {t("settings.storageDisk", { path: summary.diskPath })}
                </p>
                <div
                  className="flex h-7 w-full overflow-hidden rounded-lg"
                  role="img"
                  aria-label={segments
                    .map((part) => `${part.label}: ${formatBytes(part.bytes)}`)
                    .join(", ")}
                >
                  {segments.map((part) => (
                    <div
                      key={part.label}
                      className={part.color}
                      style={{
                        width: `${summary.diskTotalBytes ? (part.bytes / summary.diskTotalBytes) * 100 : 0}%`,
                      }}
                      title={`${part.label}: ${formatBytes(part.bytes)}`}
                    />
                  ))}
                </div>
                <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  {segments.map((part) => (
                    <li key={part.label} className="flex items-center gap-2">
                      <span className={`h-3 w-3 shrink-0 rounded ${part.color}`} />
                      {part.label}
                      <span className="ml-auto font-mono">{formatBytes(part.bytes)}</span>
                    </li>
                  ))}
                </ul>
                {!summary.cacheOnLibraryVolume && (
                  <p className="text-sm">
                    {t("settings.storageCacheOnOtherDisk", {
                      size: formatBytes(summary.cacheBytes),
                      path: summary.cachePath,
                    })}
                  </p>
                )}
                {(summary.diskOfflineBytes !== summary.offlineBytes ||
                  summary.diskPendingUploadBytes !== summary.pendingUploadBytes) && (
                  <p className="text-sm">
                    {t("settings.storageAcrossAllDisks", {
                      offline: formatBytes(summary.offlineBytes),
                      pending: formatBytes(summary.pendingUploadBytes),
                    })}
                  </p>
                )}
                {summary.cacheOverLimitBytes > 0 && (
                  <div role="alert" className="alert alert-warning alert-soft text-sm">
                    <span>
                      Cache is {formatBytes(summary.cacheOverLimitBytes)} over the{" "}
                      {formatBytes(summary.cacheLimitBytes)} limit.{" "}
                      {summary.pinnedPath
                        ? t("settings.storagePinned", { size: formatBytes(summary.pinnedBytes) })
                        : t("settings.storageCleanupFailed")}
                    </span>
                  </div>
                )}
                {summary.warnings.length > 0 && (
                  <details className="collapse collapse-arrow bg-base-200">
                    <summary className="collapse-title text-sm">
                      {t("settings.storageWarnings")}
                    </summary>
                    <div className="collapse-content text-xs">
                      {summary.warnings.map((warning, index) => (
                        <p key={index}>{warning}</p>
                      ))}
                    </div>
                  </details>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm self-start"
                  disabled={storage.isFetching}
                  onClick={() => void storage.refetch()}
                >
                  {t("settings.refreshDiskUsage")}
                </button>
              </>
            )}
            <LocalStorageGroups />
            <fieldset className="fieldset">
              <legend className="fieldset-legend">{t("settings.maxDisposableCache")}</legend>
              <div className="flex flex-wrap gap-2">
                <input
                  className="input w-36"
                  type="number"
                  min="0"
                  step="0.1"
                  value={limitGiB}
                  onChange={(event) => setLimitGiB(event.target.value)}
                  aria-label={t("settings.maxCacheSizeAria")}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!current || save.isPending}
                  onClick={() => {
                    const bytes = Number(limitGiB) * 1024 ** 3;
                    if (
                      limitGiB.trim() === "" ||
                      !Number.isSafeInteger(Math.round(bytes)) ||
                      bytes < 0
                    ) {
                      setInputError(t("settings.invalidCacheLimit"));
                      return;
                    }
                    setInputError("");
                    if (current) save.mutate({ ...current, maxCacheBytes: Math.round(bytes) });
                  }}
                >
                  {t("settings.saveCacheLimit")}
                </button>
              </div>
            </fieldset>
            <p className="text-sm text-base-content/70">{t("settings.cacheLimitHelp")}</p>
            <button
              type="button"
              className="btn btn-outline btn-error self-start"
              disabled={clear.isPending}
              onClick={() => setConfirmCacheRemoval(true)}
            >
              {clear.isPending ? t("settings.clearing") : t("settings.deleteDisposableCache")}
            </button>
            {confirmCacheRemoval && (
              <StorageConfirmationDialog
                title={t("settings.deleteDisposableCache")}
                description={t("settings.deleteCacheConfirm")}
                busy={clear.isPending}
                onClose={() => setConfirmCacheRemoval(false)}
                onConfirm={() =>
                  clear.mutate(undefined, {
                    onSettled: () => setConfirmCacheRemoval(false),
                  })
                }
              />
            )}
            {clear.isSuccess && (
              <p role="status" className="text-sm text-success">
                {t("settings.removedCache", { size: formatBytes(clear.data) })}
              </p>
            )}
            {save.isSuccess && (
              <p role="status" className="text-sm text-success">
                {t("settings.preferencesSaved")}
              </p>
            )}
          </>
        ) : (
          <>
            {(["streamingVideoQuality", "offlineVideoQuality"] as const).map((field) => (
              <fieldset className="fieldset" key={field}>
                <legend className="fieldset-legend">
                  {field === "streamingVideoQuality"
                    ? t("settings.playbackQuality")
                    : t("settings.offlineVideoQuality")}
                </legend>
                <select
                  className="select w-full"
                  value={
                    current?.[field] ?? (field === "streamingVideoQuality" ? "server" : "original")
                  }
                  disabled={!current || save.isPending || !videoOptions.data}
                  onChange={(event) => saveQuality(field, event.target.value as VideoQuality)}
                >
                  {videoOptions.data?.options.map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </fieldset>
            ))}
            <p role="status" className="text-sm text-base-content/70">
              {videoOptions.data?.message ??
                (videoOptions.isPending
                  ? t("settings.checkingVideoCapabilities")
                  : t("settings.videoCapabilitiesFailed"))}
            </p>
            {videoOptions.error && (
              <p role="alert" className="text-error">
                {String(videoOptions.error)}
              </p>
            )}
            <p className="text-sm text-base-content/60">{t("settings.videoFutureDownloads")}</p>
          </>
        )}
      </div>
    </section>
  );
}
