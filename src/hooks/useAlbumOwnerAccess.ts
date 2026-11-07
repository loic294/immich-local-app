import { useEffect, useState } from "react";
import { canManageAlbumSharing } from "../api/tauri";
import type { AlbumOwnerAccess } from "../types";
import { isOfflineFailure } from "../utils/albumFailure";
import { useConnectionContext } from "./connectionContext";

interface OwnerVerdict {
  albumId: string;
  owner: boolean;
}

/**
 * Whether the signed-in account owns the given album. The cached owner id only
 * matches the primary account, so an album owned by another signed-in account is
 * confirmed with the server (once per album while online) instead of being
 * treated as someone else's. Reports "checking" until that answer arrives.
 */
export function useAlbumOwnerAccess(
  albumId: string | null,
  ownerId: string | null,
  userId: string,
): AlbumOwnerAccess {
  const { isOnline } = useConnectionContext();
  const [verdict, setVerdict] = useState<OwnerVerdict | null>(null);
  const ownedByPrimary = ownerId !== null && ownerId === userId;

  useEffect(() => {
    if (albumId === null || ownedByPrimary || isOnline !== true) {
      return;
    }
    let cancelled = false;
    void canManageAlbumSharing(albumId)
      .then((owner) => {
        if (cancelled) return;
        console.info("[album-owner-access] verified with server", { albumId, owner });
        setVerdict({ albumId, owner });
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        console.warn("[album-owner-access] owner check failed", { albumId, failure });
        // An unreachable server proves nothing, so keep waiting for the next probe.
        if (!isOfflineFailure(failure)) {
          setVerdict({ albumId, owner: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [albumId, ownedByPrimary, isOnline]);

  if (albumId === null) return "not-owner";
  if (ownedByPrimary) return "owner";
  if (verdict?.albumId === albumId) return verdict.owner ? "owner" : "not-owner";
  return "checking";
}
