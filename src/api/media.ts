import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../types";

export interface MediaPreferences {
  editorExecutable: string;
  editorExportArgs: string[];
  editorSidecars: string[];
  importRequiresAlbum: boolean;
  telemetryEnabled: boolean;
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
}
export interface EditorJob {
  assetId: string;
  localPath: string;
}
export const getMediaPreferences = () => invoke<MediaPreferences>("get_media_preferences");
export const updateMediaPreferences = (preferences: MediaPreferences) =>
  invoke<MediaPreferences>("update_media_preferences", { preferences });
export const listMediaDevices = () => invoke<string[]>("list_media_devices");
export const scanImportMedia = (root: string, page: number, kind: string) =>
  invoke<ImportPage>("scan_import_media", { root, page, kind });
export const getImportPreview = (path: string) => invoke<string>("get_import_preview", { path });
export const importMedia = (paths: string[], albumId: string | null) =>
  invoke<number>("import_media", { paths, albumId });
export const getMediaUploads = () => invoke<UploadJob[]>("get_media_uploads");
export const flushMediaUploads = () => invoke<number>("flush_media_uploads");
export const retryMediaUploads = () => invoke<void>("retry_media_uploads");
export const beginMediaEdit = (assetIds: string[]) =>
  invoke<void>("begin_media_edit", { assetIds });
export const getChangedEditorJobs = () => invoke<EditorJob[]>("get_changed_editor_jobs");
export const exportMediaEdits = (assetIds: string[]) =>
  invoke<number>("export_media_edits", { assetIds });
export const getEditVersions = (assetId: string) =>
  invoke<AssetSummary[]>("get_edit_versions", { assetId });
export const trackMediaEvent = (event: string) => invoke<void>("track_media_event", { event });
export function requestMediaEdit(assetIds: string[], albumId?: string): void {
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
