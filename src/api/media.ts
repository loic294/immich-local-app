import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../types";

export interface MediaPreferences {
  editorExecutable: string;
  editorExportArgs: string[];
  editorSidecars: string[];
  importRequiresAlbum: boolean;
  telemetryEnabled: boolean;
  sessionReplayEnabled: boolean;
}
export interface ImportFile {
  path: string;
  name: string;
  kind: "photo" | "video";
  size: number;
  checksum: string;
  alreadyImported: boolean;
}
export interface ImportPage {
  files: ImportFile[];
  hasMore: boolean;
}
export interface UploadJob {
  id: string;
  accountId: string;
  localPath: string;
  state: string;
  error: string | null;
  originalAssetId: string | null;
  serverAssetId: string | null;
}
export interface EditorJob {
  assetId: string;
  localPath: string;
  previewPath?: string | null;
  previewError?: string | null;
}
export interface EditImportState {
  previewSrc: string | null;
  state: "importing" | "queued" | "failed" | "loading";
  error?: string | null;
  versionId?: string;
  uploadJobId?: string;
}
export interface MediaEditState {
  assetIds: string[];
  phase: "idle" | "launching" | "editing";
  imports: Record<string, EditImportState>;
}
let editState: MediaEditState = { assetIds: [], phase: "idle", imports: {} };
const editListeners = new Set<() => void>();
export const getMediaEditState = () => editState;
export function subscribeMediaEditState(listener: () => void): () => void {
  editListeners.add(listener);
  return () => {
    editListeners.delete(listener);
  };
}
export function updateMediaEditState(update: Partial<MediaEditState>): void {
  editState = { ...editState, ...update };
  editListeners.forEach((listener) => listener());
}
export function updateEditImport(assetId: string, value: EditImportState | null): void {
  const imports = { ...editState.imports };
  if (value) imports[assetId] = value;
  else delete imports[assetId];
  updateMediaEditState({ imports });
}
/** Native preview paths are explicitly scoped by get_changed_editor_jobs. */
export const editPreviewSrc = (path: string | null | undefined): string | null =>
  path ? convertFileSrc(path) : null;
export const getMediaPreferences = () => invoke<MediaPreferences>("get_media_preferences");
export const updateMediaPreferences = (preferences: MediaPreferences) =>
  invoke<MediaPreferences>("update_media_preferences", { preferences }).then((value) => {
    window.dispatchEvent(new CustomEvent("media:preferences-changed", { detail: value }));
    return value;
  });
export const listMediaDevices = () => invoke<string[]>("list_media_devices");
export const scanImportMedia = (root: string, page: number, kind: string) =>
  invoke<ImportPage>("scan_import_media", { root, page, kind });
export const getImportPreview = (path: string) => invoke<string>("get_import_preview", { path });
export const importMedia = (paths: string[], albumId: string | null) =>
  invoke<number>("import_media", { paths, albumId });
export const getMediaUploads = () =>
  invoke<UploadJob[]>("get_media_uploads", {
    editJobIds: Object.values(editState.imports).flatMap((value) =>
      value.uploadJobId ? [value.uploadJobId] : [],
    ),
  });
export const flushMediaUploads = () => invoke<number>("flush_media_uploads");
export const retryMediaUploads = async () => {
  await invoke<void>("retry_media_uploads");
  for (const [id, value] of Object.entries(editState.imports)) {
    if (value.state === "failed")
      updateEditImport(id, {
        ...value,
        state: value.versionId ? "loading" : "queued",
        error: null,
      });
  }
};
export const beginMediaEdit = (assetIds: string[]) =>
  invoke<string[]>("begin_media_edit", { assetIds });
export const getChangedEditorJobs = (preparePreviews = false) =>
  invoke<EditorJob[]>("get_changed_editor_jobs", { preparePreviews });
/** Partial batch exports return queued jobs even if a later edit fails. */
export const exportMediaEdits = (assetIds: string[]) =>
  invoke<{ uploads: UploadJob[]; error: string | null }>("export_media_edits", { assetIds });
export const getEditVersions = (assetId: string) =>
  invoke<AssetSummary[]>("get_edit_versions", { assetId });
export const deleteEditVersion = (assetId: string) =>
  invoke<boolean>("delete_edit_version", { assetId });
export const trackMediaEvent = (event: string) =>
  invoke<void>("track_media_event", {
    event,
    context: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      screen: `${window.screen.width}x${window.screen.height}`,
      hostname: window.location.hostname || "immich-local-app",
    },
  });
export function requestMediaEdit(assetIds: string[], albumId?: string): void {
  if (
    !assetIds.length ||
    editState.phase !== "idle" ||
    assetIds.some((id) => editState.imports[id])
  )
    return;
  updateMediaEditState({ assetIds, phase: "launching" });
  window.dispatchEvent(new CustomEvent("media:edit-request", { detail: { assetIds, albumId } }));
}
export function requestMediaImport(): void {
  window.dispatchEvent(new Event("media:import-request"));
}
export function trackFeature(feature: string): void {
  void trackMediaEvent(`feature-${feature}`).catch((error) =>
    console.warn("[telemetry] feature event unavailable", error),
  );
}
