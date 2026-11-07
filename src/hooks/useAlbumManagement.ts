import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { deleteAlbum, renameAlbum } from "../api/albumManagement";
import { useAlbumManagementLabels } from "../i18n/albumManagement";
import type { AlbumSummary } from "../types";
import { failureMessage } from "../utils/albumFailure";
import { useConnectionContext } from "./connectionContext";

export type AlbumManagementDialog = "rename" | "delete" | "access";

/**
 * Owns the three-dot menu's flows for one album: which dialog is open, plus the
 * rename/delete request and its error. Both actions need the album's server, so
 * they are never queued offline; the local caches are updated directly instead
 * of re-syncing. The Manage access dialog keeps its own state in `useAlbumAccess`.
 */
export function useAlbumManagement(album: AlbumSummary, onDeleted: (albumId: string) => void) {
  const queryClient = useQueryClient();
  const labels = useAlbumManagementLabels();
  const { isOnline } = useConnectionContext();
  const [dialog, setDialog] = useState<AlbumManagementDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDialog = useCallback((next: AlbumManagementDialog) => {
    setError(null);
    setDialog(next);
  }, []);

  const closeDialog = useCallback(() => {
    setError(null);
    setDialog(null);
  }, []);

  const rename = useCallback(
    async (requestedName: string) => {
      setBusy(true);
      setError(null);
      console.info("[album-management] rename start", { albumId: album.id });
      try {
        const savedName = await renameAlbum(album.id, requestedName);
        queryClient.setQueryData<AlbumSummary[]>(
          ["albums"],
          (current) =>
            current?.map((item) =>
              item.id === album.id ? { ...item, albumName: savedName } : item,
            ) ?? current,
        );
        console.info("[album-management] rename success", { albumId: album.id });
        setDialog(null);
      } catch (failure) {
        console.error("[album-management] rename failed", { albumId: album.id, failure });
        setError(failureMessage(failure, labels.renameFailed, labels.offline));
      } finally {
        setBusy(false);
      }
    },
    [album.id, labels, queryClient],
  );

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    console.info("[album-management] delete start", { albumId: album.id });
    try {
      await deleteAlbum(album.id);
      console.info("[album-management] delete success", { albumId: album.id });
      onDeleted(album.id);
      queryClient.setQueryData<AlbumSummary[]>(
        ["albums"],
        (current) => current?.filter((item) => item.id !== album.id) ?? current,
      );
      queryClient.removeQueries({ queryKey: ["album-assets-paged", album.id] });
      queryClient.removeQueries({ queryKey: ["album-local-status", album.id] });
      setDialog(null);
    } catch (failure) {
      console.error("[album-management] delete failed", { albumId: album.id, failure });
      setError(failureMessage(failure, labels.deleteFailed, labels.offline));
    } finally {
      setBusy(false);
    }
  }, [album.id, labels, onDeleted, queryClient]);

  return {
    dialog,
    busy,
    error,
    online: isOnline === true,
    openDialog,
    closeDialog,
    rename,
    remove,
  };
}
