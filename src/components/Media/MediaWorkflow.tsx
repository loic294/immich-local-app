import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  beginMediaEdit,
  exportMediaEdits,
  flushMediaUploads,
  getChangedEditorJobs,
  getMediaUploads,
  listMediaDevices,
  retryMediaUploads,
  trackFeature,
  trackMediaEvent,
  type EditorJob,
  type UploadJob,
} from "../../api/media";
import { useConnectionContext } from "../../hooks/connectionContext";
import { useMediaLabels } from "../../i18n/media";
import { useSessionReplay } from "../../hooks/useSessionReplay";
import { ImportDialog } from "./ImportDialog";

interface MediaWorkflowProps {
  enabled: boolean;
  page: string;
}
export function MediaWorkflow({ enabled, page }: MediaWorkflowProps) {
  const labels = useMediaLabels();
  useSessionReplay(enabled);
  const { isOnline } = useConnectionContext();
  const queryClient = useQueryClient();
  const [importRoot, setImportRoot] = useState<string | null | undefined>(undefined);
  const [mountedDevice, setMountedDevice] = useState<string | null>(null);
  const [changes, setChanges] = useState<EditorJob[]>([]);
  const [uploads, setUploads] = useState<UploadJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const deviceRoots = useRef<Set<string> | null>(null);
  const scanning = useRef(false);
  const dismissedEdits = useRef(false);
  const mountedQueue = useRef<string[]>([]);
  const flushing = useRef(false);
  const previousUploads = useRef<UploadJob[]>([]);
  const updateUploads = useCallback(
    (jobs: UploadJob[]) => {
      const remaining = new Set(jobs.map((job) => job.id));
      const completed = previousUploads.current.some((job) => !remaining.has(job.id));
      previousUploads.current = jobs;
      setUploads(jobs);
      if (completed) {
        console.info("[media:queue] completed uploads; refreshing cached views");
        void queryClient
          .invalidateQueries()
          .catch((error) => console.error("[media:queue] cache refresh failed", error));
      }
    },
    [queryClient],
  );
  const refresh = useCallback(
    async (uploaded: boolean) => {
      const jobs = await getMediaUploads();
      updateUploads(jobs);
      if (uploaded) await queryClient.invalidateQueries();
    },
    [queryClient, updateUploads],
  );
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const count = await flushMediaUploads();
      await refresh(count > 0);
    } catch (error) {
      console.error("[media:queue] flush failed", error);
      if (!String(error).startsWith("offline:")) setError(String(error));
    } finally {
      flushing.current = false;
    }
  }, [refresh]);
  const inspect = useCallback(async () => {
    if (scanning.current) return;
    scanning.current = true;
    try {
      const [roots, edited, jobs] = await Promise.all([
        listMediaDevices(),
        getChangedEditorJobs(),
        getMediaUploads(),
      ]);
      if (deviceRoots.current) {
        for (const root of roots)
          if (!deviceRoots.current.has(root)) mountedQueue.current.push(root);
        if (mountedQueue.current.length)
          setMountedDevice((current) => current ?? mountedQueue.current.shift() ?? null);
      }
      deviceRoots.current = new Set(roots);
      if (!dismissedEdits.current) setChanges(edited);
      updateUploads(jobs);
    } catch (error) {
      console.error("[media:scan] inspection failed", error);
      setError(String(error));
    } finally {
      scanning.current = false;
    }
  }, [updateUploads]);
  useEffect(() => {
    if (!enabled) return;
    void inspect();
    const timer = window.setInterval(() => void inspect(), 10_000);
    const focus = () => {
      dismissedEdits.current = false;
      void inspect();
    };
    window.addEventListener("focus", focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [enabled, inspect]);
  useEffect(() => {
    if (enabled && isOnline === true) void flush();
  }, [enabled, isOnline, flush]);
  const hasPendingUploads = uploads.some(
    (job) => job.state === "queued" || job.state === "uploading",
  );
  useEffect(() => {
    if (!enabled || !hasPendingUploads) return;
    if (isOnline === true) void flush();
    const timer = window.setInterval(() => {
      void getMediaUploads()
        .then(updateUploads)
        .catch((error) => console.error("[media:upload] progress refresh failed", error));
      if (isOnline === true) void flush();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [enabled, hasPendingUploads, isOnline, flush, updateUploads]);
  useEffect(() => {
    if (enabled)
      void trackMediaEvent(`page-${page}`).catch((error) =>
        console.warn("[telemetry] page event unavailable", error),
      );
  }, [enabled, page]);
  useEffect(() => {
    if (!enabled) return;
    const edit = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (
        typeof detail !== "object" ||
        !detail ||
        !("assetIds" in detail) ||
        !Array.isArray(detail.assetIds) ||
        !detail.assetIds.every((id) => typeof id === "string")
      )
        return;
      setBusy(true);
      setError(null);
      void beginMediaEdit(detail.assetIds)
        .then(() => {
          dismissedEdits.current = false;
          trackFeature("edit");
        })
        .catch((error) => {
          console.error("[media:editor] launch failed", error);
          setError(`${labels.editFailed} ${String(error)}`);
        })
        .finally(() => setBusy(false));
    };
    const importing = () => setImportRoot(null);
    window.addEventListener("media:edit-request", edit);
    window.addEventListener("media:import-request", importing);
    return () => {
      window.removeEventListener("media:edit-request", edit);
      window.removeEventListener("media:import-request", importing);
    };
  }, [enabled, labels.editFailed]);
  const exportChanges = async () => {
    setBusy(true);
    setError(null);
    try {
      await exportMediaEdits(changes.map((job) => job.assetId));
      setChanges([]);
      trackFeature("export");
      await flush();
    } catch (error) {
      console.error("[media:export] failed", error);
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!enabled) return null;
  return (
    <>
      <div className="fixed bottom-3 right-3 z-50 flex gap-2">
        {uploads.length > 0 && (
          <button className="btn btn-sm btn-warning" onClick={() => setShowQueue(true)}>
            {labels.queue} ({uploads.length})
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="toast toast-end z-[10050]">
          <div className="alert alert-error max-w-xl">
            <span>{error}</span>
            <button className="btn btn-sm" onClick={() => setError(null)}>
              {labels.close}
            </button>
          </div>
        </div>
      )}
      {mountedDevice && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={labels.mounted}
          className="modal modal-open"
        >
          <div className="modal-box">
            <h2 className="text-lg font-semibold">{labels.mounted}</h2>
            <p className="my-3">{labels.mountedHelp}</p>
            <p className="break-all text-sm">{mountedDevice}</p>
            <div className="modal-action">
              <button
                className="btn"
                onClick={() => setMountedDevice(mountedQueue.current.shift() ?? null)}
              >
                {labels.cancel}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setImportRoot(mountedDevice);
                  setMountedDevice(null);
                }}
              >
                {labels.import}
              </button>
            </div>
          </div>
        </div>
      )}
      {importRoot !== undefined && (
        <ImportDialog
          initialRoot={importRoot}
          onClose={() => setImportRoot(undefined)}
          onImported={flush}
        />
      )}
      {changes.length > 0 && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={labels.exportTitle}
          className="modal modal-open z-[10000]"
        >
          <div className="modal-box">
            <h2 className="text-lg font-semibold">{labels.exportTitle}</h2>
            <p className="my-3 text-sm">{labels.exportHelp}</p>
            <div className="max-h-48 overflow-auto text-sm">
              {changes.map((job) => (
                <p key={job.assetId} className="break-all">
                  {job.localPath}
                </p>
              ))}
            </div>
            <div className="modal-action">
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  dismissedEdits.current = true;
                  setChanges([]);
                }}
              >
                {labels.later}
              </button>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void exportChanges()}
              >
                {busy ? labels.busy : labels.export}
              </button>
            </div>
          </div>
        </div>
      )}
      {showQueue && (
        <div role="dialog" aria-modal="true" aria-label={labels.queue} className="modal modal-open">
          <div className="modal-box">
            <h2 className="text-lg font-semibold">
              {labels.queue} ({uploads.length})
            </h2>
            {uploads.some((job) => job.state === "uploading") && (
              <p role="status" className="flex items-center gap-2 text-sm">
                <span className="loading loading-spinner loading-sm" />
                {labels.uploadProgress}
              </p>
            )}
            <div className="my-4 max-h-72 space-y-3 overflow-auto">
              {uploads.map((job) => (
                <div key={job.id}>
                  <p className="break-all text-sm">{job.localPath}</p>
                  <p className={job.error ? "text-error" : "text-base-content/60"}>
                    {job.state === "queued"
                      ? labels.queued
                      : job.state === "uploading"
                        ? labels.uploading
                        : job.state === "failed"
                          ? labels.failed
                          : job.state === "complete"
                            ? labels.complete
                            : labels.unknownState}
                  </p>
                  {job.error && <p className="text-sm text-error">{job.error}</p>}
                  {job.state === "uploading" && (
                    <progress
                      max={100}
                      className="progress progress-primary w-full"
                      aria-label={labels.uploading}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="modal-action">
              <button className="btn" onClick={() => setShowQueue(false)}>
                {labels.close}
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || isOnline !== true}
                onClick={() => {
                  setBusy(true);
                  void retryMediaUploads()
                    .then(flush)
                    .catch((error) => {
                      console.error("[media:queue] retry failed", error);
                      setError(String(error));
                    })
                    .finally(() => setBusy(false));
                }}
              >
                {labels.retry}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
