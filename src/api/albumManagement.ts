import { invoke } from "@tauri-apps/api/core";

function notifyAlbumsChanged() {
  window.dispatchEvent(new Event("recent-albums-changed"));
}

/** Renames the album on the server and in the local cache; resolves to the saved name. */
export async function renameAlbum(albumId: string, albumName: string): Promise<string> {
  const savedName = await invoke<string>("rename_album", { albumId, albumName });
  notifyAlbumsChanged();
  return savedName;
}

/**
 * Deletes the album on the server and drops its cache rows. Never queued: the
 * command fails with an `offline:`-prefixed error when the server is unreachable.
 */
export async function deleteAlbum(albumId: string): Promise<void> {
  await invoke<void>("delete_album", { albumId });
  notifyAlbumsChanged();
}
