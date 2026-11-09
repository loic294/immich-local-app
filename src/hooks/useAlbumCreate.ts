import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createAlbumWithAssets } from "../api/tauri";
import { useAlbumManagementLabels } from "../i18n/albumManagement";
import { toast } from "../toasts/toast";
import { useConnectionContext } from "./connectionContext";

interface UseAlbumCreateOptions {
  /** Called once the album exists, so the caller can open it. */
  onCreated: (albumId: string) => void;
}

/**
 * Owns the "Create new album" flow: whether the dialog is open, the in-flight request and its
 * error. The album starts empty; photos are added later through Add to album. Creating needs the
 * album owner's server, so it is never queued offline.
 */
export function useAlbumCreate({ onCreated }: UseAlbumCreateOptions) {
  const queryClient = useQueryClient();
  const labels = useAlbumManagementLabels();
  const { isOnline } = useConnectionContext();
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(() => {
    setError(null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setError(null);
    setIsOpen(false);
  }, []);

  const create = useCallback(
    async (albumName: string) => {
      setBusy(true);
      setError(null);
      console.info("[album-create] start");
      try {
        const album = await createAlbumWithAssets(albumName, []);
        console.info("[album-create] success", { albumId: album.id });
        await queryClient.invalidateQueries({ queryKey: ["albums"] });
        setIsOpen(false);
        toast.success("album.created", { name: album.albumName || albumName });
        onCreated(album.id);
      } catch (failure) {
        console.error("[album-create] failed", { failure });
        const raw =
          failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
        setError(
          raw.startsWith("offline:") ? labels.createOffline : raw.trim() || labels.createFailed,
        );
        // The album may exist in the cache even when a later step failed.
        void queryClient.invalidateQueries({ queryKey: ["albums"] });
      } finally {
        setBusy(false);
      }
    },
    [labels, onCreated, queryClient],
  );

  return { isOpen, busy, error, online: isOnline === true, open, close, create };
}
