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
import { ImportDialog } from "./ImportDialog";

interface MediaWorkflowProps {
  enabled: boolean;
  page: string;
}
export function MediaWorkflow({ enabled, page }: MediaWorkflowProps) {
  const labels = useMediaLabels();
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
  const refresh = useCallback(async () => {
    const jobs = await getMediaUploads();
    setUploads(jobs);
    await queryClient.invalidateQueries();
  }, [queryClient]);
  const flush = useCallback(async () => {
    try {
      await flushMediaUploads();
      await refresh();
    } catch (error) {
      console.error("[media:queue] flush failed", error);
      setError(String(error));
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
      setUploads(jobs);
    } catch (error) {
      console.error("[media:scan] inspection failed", error);
      setError(String(error));
    } finally {
      scanning.current = false;
    }
  }, []);
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
          setError(String(error));
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
  }, [enabled]);
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
        <button className="btn btn-sm" disabled={busy} onClick={() => setImportRoot(null)}>
          {labels.import}
        </button>
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
            <h2 className="text-lg font-semibold">{labels.queue}</h2>
            <div className="my-4 max-h-72 space-y-3 overflow-auto">
              {uploads.map((job) => (
                <div key={job.id}>
                  <p className="break-all text-sm">{job.localPath}</p>
                  <p className={job.error ? "text-error" : "text-base-content/60"}>
                    {job.error ?? job.state}
                  </p>
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
