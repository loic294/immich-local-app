import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  beginMediaEdit,
  editPreviewSrc,
  getEditVersions,
  getMediaEditState,
  subscribeMediaEditState,
  updateMediaEditState,
  updateEditImport,
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
  const openingVersions = useRef(new Set<string>());
  const importingEdits = useRef(false);
  const launchedSession = useRef(false);
  const [editPhase, setEditPhase] = useState(getMediaEditState().phase);
  useEffect(() => subscribeMediaEditState(() => setEditPhase(getMediaEditState().phase)), []);
  const updateUploads = useCallback(
    (jobs: UploadJob[]) => {
      const remaining = new Set(jobs.map((job) => job.id));
      const previousStates = new Map(previousUploads.current.map((job) => [job.id, job.state]));
      const completed =
        previousUploads.current.some((job) => !remaining.has(job.id)) ||
        jobs.some((job) => job.state === "complete" && previousStates.get(job.id) !== "complete");
      previousUploads.current = jobs;
      setUploads(jobs.filter((job) => job.state !== "complete"));
      for (const job of jobs) {
        if (!job.originalAssetId) continue;
        const id = job.originalAssetId;
        const current = getMediaEditState().imports[id];
        if (!current && job.state === "complete") continue;
        if (current?.uploadJobId && current.uploadJobId !== job.id) continue;
        updateEditImport(id, {
          ...current,
          previewSrc: current?.previewSrc ?? editPreviewSrc(job.localPath),
          uploadJobId: job.id,
          state:
            job.state === "failed"
              ? "failed"
              : job.state === "queued"
                ? "queued"
                : job.state === "complete"
                  ? "loading"
                  : "importing",
          error: job.error,
        });
        if (
          job.state !== "complete" ||
          !job.serverAssetId ||
          current?.versionId === job.serverAssetId ||
          openingVersions.current.has(job.id)
        )
          continue;
        openingVersions.current.add(job.id);
        void getEditVersions(id)
          .then((versions) => {
            const version = versions.find((asset) => asset.id === job.serverAssetId);
            if (!version) throw new Error("Imported edit is not yet cached");
            const latest = getMediaEditState().imports[id];
            if (!latest || latest.uploadJobId !== job.id) return;
            updateEditImport(id, { ...latest, state: "loading", versionId: version.id });
            window.dispatchEvent(
              new CustomEvent("media:open-version", {
                detail: { assetId: version.id, sourceAssetId: id, asset: version },
              }),
            );
            console.info(
              `[media:edit-import] stacked version ready original=${id} version=${version.id}`,
            );
          })
          .catch((error) => console.error("[media:edit-import] version lookup failed", error))
          .finally(() => openingVersions.current.delete(job.id));
      }
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
        getChangedEditorJobs(getMediaEditState().phase === "idle"),
        getMediaUploads(),
      ]);
      if (deviceRoots.current) {
        for (const root of roots)
          if (!deviceRoots.current.has(root)) mountedQueue.current.push(root);
        if (mountedQueue.current.length)
          setMountedDevice((current) => current ?? mountedQueue.current.shift() ?? null);
      }
      deviceRoots.current = new Set(roots);
      if (
        !dismissedEdits.current &&
        getMediaEditState().phase === "idle" &&
        !importingEdits.current
      )
        setChanges(edited);
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
  const hasPendingUploads =
    uploads.length > 0 || Object.keys(getMediaEditState().imports).length > 0;
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
      if (getMediaEditState().phase !== "launching" || launchedSession.current) return;
      launchedSession.current = true;
      setError(null);
      console.info("[media:editor] launching session", detail.assetIds.length);
      void beginMediaEdit(detail.assetIds)
        .then(() => {
          updateMediaEditState({ phase: "editing" });
          dismissedEdits.current = false;
          trackFeature("edit");
        })
        .catch((error) => {
          console.error("[media:editor] launch failed", error);
          updateMediaEditState({ phase: "idle", assetIds: [] });
          launchedSession.current = false;
          setError(`${labels.editFailed} ${String(error)}`);
        });
    };
    const finish = () => {
      console.info("[media:editor] explicit finish; final sidecar scan");
      void getChangedEditorJobs(true)
        .then((edited) => {
          dismissedEdits.current = false;
          setChanges(edited);
          updateMediaEditState({ phase: "idle", assetIds: [] });
          launchedSession.current = false;
        })
        .catch((error) => {
          console.error("[media:editor] final scan failed", error);
          updateMediaEditState({ phase: "editing" });
          setError(String(error));
        });
    };
    const importing = () => setImportRoot(null);
    const showUploadQueue = () => setShowQueue(true);
    window.addEventListener("media:edit-request", edit);
    window.addEventListener("media:finish-edit", finish);
    window.addEventListener("media:show-upload-queue", showUploadQueue);
    window.addEventListener("media:import-request", importing);
    return () => {
      window.removeEventListener("media:edit-request", edit);
      window.removeEventListener("media:finish-edit", finish);
      window.removeEventListener("media:show-upload-queue", showUploadQueue);
      window.removeEventListener("media:import-request", importing);
    };
  }, [enabled, labels.editFailed]);
  const exportChanges = async () => {
    if (importingEdits.current) return;
    importingEdits.current = true;
    setBusy(true);
    setError(null);
    const selected = changes;
    for (const job of selected)
      updateEditImport(job.assetId, {
        previewSrc: editPreviewSrc(job.previewPath),
        state: "importing",
      });
    setChanges([]);
    try {
      const result = await exportMediaEdits(selected.map((job) => job.assetId));
      const exported = result.uploads;
      const exportedIds = new Set(exported.map((job) => job.originalAssetId));
      for (const job of selected) {
        if (!exportedIds.has(job.assetId)) updateEditImport(job.assetId, null);
      }
      for (const job of exported) {
        if (job.originalAssetId)
          updateEditImport(job.originalAssetId, {
            ...getMediaEditState().imports[job.originalAssetId],
            previewSrc: getMediaEditState().imports[job.originalAssetId]?.previewSrc ?? null,
            state: "queued",
            uploadJobId: job.id,
          });
      }
      if (result.error) throw new Error(result.error);
      trackFeature("export");
      await flush();
    } catch (error) {
      console.error("[media:export] failed", error);
      setError(String(error));
      // Partial batch exports may already be queued; never re-export those edits.
      await refresh(false).catch((error) =>
        console.error("[media:export] queue refresh failed", error),
      );
      const pending = await getChangedEditorJobs(true).catch(() => selected);
      setChanges(pending.filter((job) => !getMediaEditState().imports[job.assetId]?.uploadJobId));
      for (const job of selected) {
        const current = getMediaEditState().imports[job.assetId];
        if (current && !current.uploadJobId) updateEditImport(job.assetId, null);
      }
    } finally {
      importingEdits.current = false;
      setBusy(false);
    }
  };
  if (!enabled) return null;
  return (
    <>
      <div className="fixed bottom-3 right-3 z-[10020] flex gap-2">
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
      {changes.length > 0 && editPhase === "idle" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={labels.exportTitle}
          className="modal modal-open z-[10000]"
        >
          <div className="modal-box">
            <h2 className="text-lg font-semibold">{labels.exportTitle}</h2>
            <div className="my-3 max-h-96 space-y-3 overflow-auto text-sm">
              {changes.map((job) => (
                <div key={job.assetId}>
                  {job.previewPath ? (
                    <img
                      src={editPreviewSrc(job.previewPath)!}
                      alt={labels.editPreview}
                      className="mx-auto max-h-64 max-w-full rounded-box object-contain"
                      onError={() =>
                        console.error(
                          `[media:edit-preview] image load failed original=${job.assetId}`,
                        )
                      }
                    />
                  ) : (
                    <p className="text-warning">{job.previewError ?? labels.preview}</p>
                  )}
                  <p className="break-all text-base-content/60">{job.localPath}</p>
                </div>
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
        <div
          role="dialog"
          aria-modal="true"
          aria-label={labels.queue}
          className="modal modal-open z-[10030]"
        >
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
