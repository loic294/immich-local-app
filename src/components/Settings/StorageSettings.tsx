import { useEffect, useState } from "react";
import { useStorageSettings } from "../../hooks/useSettings";
import type { VideoQuality } from "../../types/storage";

interface StorageSettingsProps {
  section: "storage" | "video";
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}

export function StorageSettings({ section }: StorageSettingsProps) {
  const { preferences, storage, videoOptions, save, clear } = useStorageSettings();
  const [limitGiB, setLimitGiB] = useState("");
  const [inputError, setInputError] = useState("");
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
          label: "Cache",
          bytes: summary.cacheOnLibraryVolume ? summary.cacheBytes : 0,
          color: "bg-primary",
        },
        { label: "Offline content", bytes: summary.diskOfflineBytes, color: "bg-secondary" },
        { label: "Not uploaded yet", bytes: summary.diskPendingUploadBytes, color: "bg-accent" },
        { label: "Other disk usage", bytes: summary.otherUsedBytes, color: "bg-neutral" },
        { label: "Free disk space", bytes: summary.diskAvailableBytes, color: "bg-base-300" },
      ]
    : [];

  return (
    <section className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body">
        <h2 className="card-title">
          {section === "storage" ? "Storage & cache" : "Video quality"}
        </h2>
        {errors.map((error, index) => (
          <p role="alert" className="text-sm text-error" key={index}>
            {String(error)}
          </p>
        ))}
        {section === "storage" ? (
          <>
            {storage.isPending && (
              <span className="loading loading-spinner" aria-label="Measuring storage" />
            )}
            {summary && (
              <>
                <p className="break-all text-sm text-base-content/60">Disk: {summary.diskPath}</p>
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
                    Cache on another disk: {formatBytes(summary.cacheBytes)} ({summary.cachePath}).
                    Not included in this disk's bar.
                  </p>
                )}
                {(summary.diskOfflineBytes !== summary.offlineBytes ||
                  summary.diskPendingUploadBytes !== summary.pendingUploadBytes) && (
                  <p className="text-sm">
                    Across all disks: {formatBytes(summary.offlineBytes)} retained offline,{" "}
                    {formatBytes(summary.pendingUploadBytes)} awaiting upload. The bar shows only
                    the selected disk.
                  </p>
                )}
                {summary.cacheOverLimitBytes > 0 && (
                  <div role="alert" className="alert alert-warning alert-soft text-sm">
                    <span>
                      Cache is {formatBytes(summary.cacheOverLimitBytes)} over the{" "}
                      {formatBytes(summary.cacheLimitBytes)} limit.{" "}
                      {summary.pinnedPath
                        ? `The video in use (${formatBytes(summary.pinnedBytes)}) is larger than the remaining room and is kept so playback is not interrupted; it is evicted on the next cache write after playback moves on.`
                        : "Some cache files could not be deleted; see the logs or try deleting the cache again."}
                    </span>
                  </div>
                )}
                {summary.warnings.length > 0 && (
                  <details className="collapse collapse-arrow bg-base-200">
                    <summary className="collapse-title text-sm">
                      Some retained files could not be measured
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
                  Refresh disk usage
                </button>
              </>
            )}
            <fieldset className="fieldset">
              <legend className="fieldset-legend">Maximum disposable cache (GiB)</legend>
              <div className="flex flex-wrap gap-2">
                <input
                  className="input w-36"
                  type="number"
                  min="0"
                  step="0.1"
                  value={limitGiB}
                  onChange={(event) => setLimitGiB(event.target.value)}
                  aria-label="Maximum cache size in GiB"
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
                      setInputError("Enter a valid, non-negative cache limit.");
                      return;
                    }
                    setInputError("");
                    if (current) save.mutate({ ...current, maxCacheBytes: Math.round(bytes) });
                  }}
                >
                  Save cache limit
                </button>
              </div>
            </fieldset>
            <p className="text-sm text-base-content/70">
              The limit is enforced after every cache write: oldest thumbnails and playback videos
              are evicted first, then cached previews of offline items if still needed. Offline
              downloads, pending uploads and your local database are never deleted. The video
              currently playing is kept until playback moves on. Manual deletion keeps previews of
              offline items.
            </p>
            <button
              type="button"
              className="btn btn-outline btn-error self-start"
              disabled={clear.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Delete disposable thumbnails and playback files? Offline content and pending uploads will be kept.",
                  )
                )
                  clear.mutate();
              }}
            >
              {clear.isPending ? "Clearing…" : "Delete disposable cache"}
            </button>
            {clear.isSuccess && (
              <p role="status" className="text-sm text-success">
                Removed {formatBytes(clear.data)} of disposable cache.
              </p>
            )}
            {save.isSuccess && (
              <p role="status" className="text-sm text-success">
                Preferences saved.
              </p>
            )}
          </>
        ) : (
          <>
            {(["streamingVideoQuality", "offlineVideoQuality"] as const).map((field) => (
              <fieldset className="fieldset" key={field}>
                <legend className="fieldset-legend">
                  {field === "streamingVideoQuality"
                    ? "Playback quality"
                    : "Offline video download quality"}
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
                  ? "Checking video capabilities…"
                  : "Video capability check failed. Existing preferences are unchanged.")}
            </p>
            {videoOptions.error && (
              <p role="alert" className="text-error">
                {String(videoOptions.error)}
              </p>
            )}
            <p className="text-sm text-base-content/60">
              Changes affect future downloads. Existing offline videos are preserved at their
              downloaded quality.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
