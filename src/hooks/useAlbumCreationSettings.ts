import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getShareableUsers, updateSettings, type Account } from "../api/tauri";
import type { AlbumUserCandidate, Settings } from "../types";

export function useAlbumCreationSettings(
  settings: Settings,
  accounts: Account[],
  onSaved: (settings: Settings) => void,
): {
  ownerAccountId: string;
  editorUserIds: string[];
  candidates: AlbumUserCandidate[];
  loading: boolean;
  loadingError: string | null;
  saving: boolean;
  saved: boolean;
  saveError: string | null;
  changeOwner: (id: string) => void;
  toggleEditor: (id: string) => void;
  reload: () => void;
  save: () => Promise<void>;
} {
  const storedOwner =
    settings.albumCreation?.ownerAccountId ??
    accounts.find((account) => account.isPrimary)?.id ??
    "";
  const [ownerAccountId, setOwnerAccountId] = useState(storedOwner);
  const [editorUserIds, setEditorUserIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const owner = accounts.find((account) => account.id === storedOwner);
    setOwnerAccountId(storedOwner);
    setEditorUserIds(
      settings.albumCreation?.editorUserIds ??
        accounts
          .filter((account) => account.serverUrl === owner?.serverUrl && account.id !== storedOwner)
          .map((account) => account.userId),
    );
  }, [storedOwner, settings.albumCreation, accounts]);

  const owner = accounts.find((account) => account.id === ownerAccountId);
  const users = useQuery({
    queryKey: ["album-editor-candidates", ownerAccountId],
    enabled: !!owner,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      try {
        return await getShareableUsers(ownerAccountId);
      } catch (error) {
        console.error("[albums.settings] load collaborators failed", { ownerAccountId, error });
        throw error;
      }
    },
  });
  const candidates = new Map<string, AlbumUserCandidate>();
  for (const account of accounts.filter((account) => account.serverUrl === owner?.serverUrl)) {
    candidates.set(account.userId, {
      id: account.userId,
      name: account.userName,
      email: account.userEmail,
    });
  }
  for (const user of users.data ?? []) candidates.set(user.id, user);
  // Retain saved selections while offline or when a user disappears from the server list.
  for (const id of editorUserIds) {
    if (!candidates.has(id)) candidates.set(id, { id, name: null, email: null });
  }
  if (owner) candidates.delete(owner.userId);

  const markDirty = () => {
    setSaved(false);
    setSaveError(null);
  };
  return {
    ownerAccountId,
    editorUserIds,
    candidates: [...candidates.values()],
    loading: users.isFetching,
    loadingError: users.error ? String(users.error) : null,
    saving,
    saved,
    saveError,
    changeOwner: (id) => {
      const next = accounts.find((account) => account.id === id);
      setOwnerAccountId(id);
      setEditorUserIds(
        next?.serverUrl === owner?.serverUrl
          ? editorUserIds.filter((userId) => userId !== next?.userId)
          : accounts
              .filter((account) => account.serverUrl === next?.serverUrl && account.id !== id)
              .map((account) => account.userId),
      );
      markDirty();
    },
    toggleEditor: (id) => {
      setEditorUserIds((current) =>
        current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
      );
      markDirty();
    },
    reload: () => void users.refetch(),
    save: async () => {
      if (saving || !owner) return;
      setSaving(true);
      markDirty();
      console.info("[albums.settings] saving", {
        ownerAccountId,
        editorCount: editorUserIds.length,
      });
      try {
        const updated = await updateSettings({
          ...settings,
          albumCreation: { ownerAccountId, editorUserIds },
        });
        onSaved(updated);
        setSaved(true);
        console.info("[albums.settings] saved", { ownerAccountId });
      } catch (error) {
        console.error("[albums.settings] save failed", error);
        setSaveError(String(error));
      } finally {
        setSaving(false);
      }
    },
  };
}
