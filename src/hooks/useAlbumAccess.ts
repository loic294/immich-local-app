import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  addUserToAlbum,
  getAlbumShareableUsers,
  getAlbumShareUsers,
  removeUserFromAlbum,
  updateAlbumUserRole,
} from "../api/tauri";
import { useAlbumAccessLabels } from "../i18n/albumAccess";
import type { AlbumShareUser, AlbumSummary, AlbumUserCandidate, AlbumUserRole } from "../types";
import { addableUsers, markAlbumShared } from "../utils/albumAccess";
import { failureMessage } from "../utils/albumFailure";
import { useConnectionContext } from "./connectionContext";

export type AlbumAccessLoadState = "loading" | "ready" | "failed";

export interface AlbumAccessState {
  online: boolean;
  loadState: AlbumAccessLoadState;
  members: AlbumShareUser[];
  /** Server users who can still be added to the album. */
  addable: AlbumUserCandidate[];
  /** The album owner as the server lists them, for albums cached without owner details. */
  ownerPerson: AlbumUserCandidate | null;
  /** The member whose permission change or removal is in flight. */
  workingUserId: string | null;
  adding: boolean;
  /** Any permission change is in flight; the modal should not close meanwhile. */
  busy: boolean;
  pendingRemovalId: string | null;
  error: string | null;
  reload: () => Promise<void>;
  changeRole: (userId: string, role: AlbumUserRole) => Promise<void>;
  addUser: (userId: string, role: AlbumUserRole) => Promise<boolean>;
  requestRemoval: (userId: string | null) => void;
  removeUser: (userId: string) => Promise<void>;
}

interface AccessChange {
  action: "role" | "add" | "remove";
  userId: string;
  failureText: string;
  run: () => Promise<void>;
}

/**
 * Owns the Manage access modal's data for one album: who has access, who could
 * still be added, and the role/add/remove requests. Every change needs the
 * album owner's server, so none are queued offline; the lists are updated from
 * the confirmed result instead of re-fetching, and one change runs at a time.
 */
export function useAlbumAccess(albumId: string, ownerId: string): AlbumAccessState {
  const queryClient = useQueryClient();
  const labels = useAlbumAccessLabels();
  const { isOnline } = useConnectionContext();
  const online = isOnline === true;
  const [loadState, setLoadState] = useState<AlbumAccessLoadState>("loading");
  const [members, setMembers] = useState<AlbumShareUser[]>([]);
  const [candidates, setCandidates] = useState<AlbumUserCandidate[]>([]);
  const [workingUserId, setWorkingUserId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const changingRef = useRef(false);

  const markShared = useCallback(() => {
    queryClient.setQueryData<AlbumSummary[]>(["albums"], (current) =>
      markAlbumShared(current, albumId),
    );
  }, [albumId, queryClient]);

  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoadState("loading");
    setError(null);
    console.info("[album-access] load start", { albumId });
    try {
      const [users, everyone] = await Promise.all([
        getAlbumShareUsers(albumId),
        getAlbumShareableUsers(albumId),
      ]);
      if (request !== loadRequestRef.current) return;
      setMembers(users);
      setCandidates(everyone);
      setLoadState("ready");
      if (users.length > 0) markShared();
      console.info("[album-access] load complete", {
        albumId,
        members: users.length,
        candidates: everyone.length,
      });
    } catch (failure) {
      if (request !== loadRequestRef.current) return;
      console.error("[album-access] load failed", { albumId, failure });
      setError(failureMessage(failure, labels.loadFailed, labels.offline));
      setLoadState("failed");
    }
  }, [albumId, labels, markShared]);

  useEffect(() => {
    if (!online) return;
    void load();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [load, online]);

  const applyChange = useCallback(
    async ({ action, userId, failureText, run }: AccessChange): Promise<boolean> => {
      if (changingRef.current) return false;
      changingRef.current = true;
      setError(null);
      setAdding(action === "add");
      setWorkingUserId(action === "add" ? null : userId);
      console.info(`[album-access] ${action} start`, { albumId, userId });
      try {
        await run();
        console.info(`[album-access] ${action} complete`, { albumId, userId });
        return true;
      } catch (failure) {
        console.error(`[album-access] ${action} failed`, { albumId, userId, failure });
        setError(failureMessage(failure, failureText, labels.offline));
        return false;
      } finally {
        changingRef.current = false;
        setAdding(false);
        setWorkingUserId(null);
      }
    },
    [albumId, labels],
  );

  const changeRole = useCallback(
    async (userId: string, role: AlbumUserRole) => {
      await applyChange({
        action: "role",
        userId,
        failureText: labels.updateFailed,
        run: async () => {
          await updateAlbumUserRole(albumId, userId, role);
          setMembers((current) =>
            current.map((member) => (member.id === userId ? { ...member, role } : member)),
          );
        },
      });
    },
    [albumId, applyChange, labels],
  );

  const addUser = useCallback(
    (userId: string, role: AlbumUserRole) =>
      applyChange({
        action: "add",
        userId,
        failureText: labels.addFailed,
        run: async () => {
          await addUserToAlbum(albumId, userId, role);
          const person = candidates.find((candidate) => candidate.id === userId);
          setMembers((current) => [
            ...current,
            { id: userId, name: person?.name ?? null, email: person?.email ?? null, role },
          ]);
          markShared();
        },
      }),
    [albumId, applyChange, candidates, labels, markShared],
  );

  const removeUser = useCallback(
    async (userId: string) => {
      const removed = await applyChange({
        action: "remove",
        userId,
        failureText: labels.removeFailed,
        run: async () => {
          await removeUserFromAlbum(albumId, userId);
          setMembers((current) => current.filter((member) => member.id !== userId));
        },
      });
      if (removed) setPendingRemovalId(null);
    },
    [albumId, applyChange, labels],
  );

  const requestRemoval = useCallback((userId: string | null) => {
    setError(null);
    setPendingRemovalId(userId);
  }, []);

  return {
    online,
    loadState,
    members,
    addable: addableUsers(candidates, ownerId, members),
    ownerPerson: candidates.find((candidate) => candidate.id === ownerId) ?? null,
    workingUserId,
    adding,
    busy: adding || workingUserId !== null,
    pendingRemovalId,
    error,
    reload: load,
    changeRole,
    addUser,
    requestRemoval,
    removeUser,
  };
}
