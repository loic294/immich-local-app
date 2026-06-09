import { useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import {
  addUserToAlbum,
  copyTextToClipboard,
  getAlbumShareLink,
  getAlbumShareUsers,
  getOrCreateAlbumShareLink,
  getShareableUsers,
  removeUserFromAlbum,
} from "../../api/tauri";
import type { AlbumShareUser, AlbumUserCandidate } from "../../types";

interface AlbumShareModalProps {
  open: boolean;
  albumId: string;
  albumName: string;
  onClose: () => void;
}

export function AlbumShareModal({
  open,
  albumId,
  albumName,
  onClose,
}: AlbumShareModalProps) {
  const [shareLink, setShareLink] = useState("");
  const [isCreatingLink, setIsCreatingLink] = useState(false);
  const [isCopyingLink, setIsCopyingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [sharedUsers, setSharedUsers] = useState<AlbumShareUser[]>([]);
  const [shareableUsers, setShareableUsers] = useState<AlbumUserCandidate[]>(
    [],
  );
  const [selectedUserId, setSelectedUserId] = useState("");
  const [userEmailInput, setUserEmailInput] = useState("");
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const usedUserIds = useMemo(
    () => new Set(sharedUsers.map((user) => user.id)),
    [sharedUsers],
  );

  const addableUsers = useMemo(
    () => shareableUsers.filter((user) => !usedUserIds.has(user.id)),
    [shareableUsers, usedUserIds],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setError(null);
    setIsLoadingUsers(true);
    setShareLink("");
    setLinkCopied(false);

    const load = async () => {
      const [usersResult, candidatesResult, linkResult] =
        await Promise.allSettled([
          getAlbumShareUsers(albumId),
          getShareableUsers(),
          getAlbumShareLink(albumId),
        ]);

      if (cancelled) {
        return;
      }

      if (usersResult.status === "fulfilled") {
        setSharedUsers(usersResult.value);
      }

      if (candidatesResult.status === "fulfilled") {
        setShareableUsers(candidatesResult.value);
      }

      if (linkResult.status === "fulfilled") {
        setShareLink(linkResult.value ?? "");
      }

      if (
        usersResult.status === "rejected" ||
        candidatesResult.status === "rejected"
      ) {
        const loadError =
          usersResult.status === "rejected"
            ? usersResult.reason
            : candidatesResult.status === "rejected"
              ? candidatesResult.reason
              : null;

        if (!cancelled) {
          const message =
            loadError instanceof Error
              ? loadError.message
              : "Could not load album sharing data";
          setError(message);
        }
      }

      if (!cancelled) {
        setIsLoadingUsers(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [albumId, open]);

  useEffect(() => {
    if (!linkCopied) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setLinkCopied(false);
    }, 2500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [linkCopied]);

  if (!open) {
    return null;
  }

  const createLink = async () => {
    setError(null);
    setLinkCopied(false);
    setIsCreatingLink(true);
    try {
      const link = await getOrCreateAlbumShareLink(albumId);
      setShareLink(link);
      await copyTextToClipboard(link);
      setLinkCopied(true);
    } catch (createError) {
      const message =
        createError instanceof Error
          ? createError.message
          : "Could not create album share link";
      setError(message);
    } finally {
      setIsCreatingLink(false);
    }
  };

  const copyLink = async () => {
    if (!shareLink.trim()) {
      return;
    }

    setError(null);
    setLinkCopied(false);
    setIsCopyingLink(true);
    try {
      await copyTextToClipboard(shareLink);
      setLinkCopied(true);
    } catch (copyError) {
      const message =
        copyError instanceof Error ? copyError.message : "Could not copy link";
      setError(message);
    } finally {
      setIsCopyingLink(false);
    }
  };

  const refreshSharedUsers = async () => {
    const users = await getAlbumShareUsers(albumId);
    setSharedUsers(users);
  };

  const addUser = async () => {
    setError(null);

    let userId = selectedUserId;
    if (!userId && userEmailInput.trim()) {
      const normalizedInput = userEmailInput.trim().toLowerCase();
      userId =
        addableUsers.find(
          (candidate) => candidate.email?.toLowerCase() === normalizedInput,
        )?.id ?? "";
    }

    if (!userId) {
      setError("Select a user or enter a known email address.");
      return;
    }

    setIsAddingUser(true);
    try {
      await addUserToAlbum(albumId, userId, "editor");
      await refreshSharedUsers();
      setSelectedUserId("");
      setUserEmailInput("");
    } catch (addError) {
      const message =
        addError instanceof Error ? addError.message : "Could not add user";
      setError(message);
    } finally {
      setIsAddingUser(false);
    }
  };

  const removeUser = async (userId: string) => {
    setError(null);
    setRemovingUserId(userId);
    try {
      await removeUserFromAlbum(albumId, userId);
      await refreshSharedUsers();
    } catch (removeError) {
      const message =
        removeError instanceof Error
          ? removeError.message
          : "Could not remove user";
      setError(message);
    } finally {
      setRemovingUserId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-120 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-2xl rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
        <h3 className="m-0 text-lg font-semibold">Share album</h3>
        <p className="mb-4 mt-1 text-sm text-base-content/70">
          Manage link sharing and user access for {albumName}.
        </p>

        {isLoadingUsers ? (
          <div className="flex min-h-72 items-center justify-center">
            <LoaderCircle
              size={38}
              className="animate-spin text-base-content/70"
              aria-label="Loading"
            />
          </div>
        ) : (
          <>
            <section className="rounded-box border border-base-300 bg-base-200/40 p-4">
              <h4 className="m-0 text-sm font-semibold uppercase tracking-wide text-base-content/70">
                Link sharing
              </h4>
              <p className="mb-3 mt-1 text-sm text-base-content/70">
                Link shares always enable metadata and public downloads.
              </p>

              {shareLink ? (
                <div className="mb-3">
                  <label className="label px-0 pb-1 pt-0">
                    <span className="label-text">Share link</span>
                  </label>
                  <input
                    type="text"
                    className="input input-bordered w-full"
                    value={shareLink}
                    readOnly
                    onClick={(event) => event.currentTarget.select()}
                    onFocus={(event) => event.currentTarget.select()}
                    onMouseUp={(event) => event.preventDefault()}
                  />
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    if (shareLink) {
                      void copyLink();
                      return;
                    }
                    void createLink();
                  }}
                  disabled={isCreatingLink || isCopyingLink}
                >
                  {isCreatingLink
                    ? "Creating..."
                    : isCopyingLink
                      ? "Copying..."
                      : shareLink
                        ? "Copy link"
                        : "Create link"}
                </button>
                {linkCopied ? (
                  <div className="inline-flex items-center gap-1 rounded-field border border-success/30 bg-success/10 px-2 py-1 text-sm text-success">
                    <Check size={14} />
                    <span>Link copied</span>
                  </div>
                ) : null}
              </div>
            </section>

            <div className="divider my-4">OR</div>

            <section className="rounded-box border border-base-300 bg-base-200/40 p-4">
              <h4 className="m-0 text-sm font-semibold uppercase tracking-wide text-base-content/70">
                User access
              </h4>
              <p className="mb-3 mt-1 text-sm text-base-content/70">
                Added users receive editor access.
              </p>

              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <select
                  className="select select-bordered"
                  value={selectedUserId}
                  onChange={(event) => setSelectedUserId(event.target.value)}
                  disabled={isAddingUser}
                >
                  <option value="">Select user</option>
                  {addableUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email || user.id}
                    </option>
                  ))}
                </select>
                <input
                  type="email"
                  className="input input-bordered"
                  value={userEmailInput}
                  onChange={(event) => setUserEmailInput(event.target.value)}
                  placeholder="Or type user email"
                  disabled={isAddingUser}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    void addUser();
                  }}
                  disabled={isAddingUser}
                >
                  {isAddingUser ? "Adding..." : "Add user"}
                </button>
              </div>

              <div className="mt-4 max-h-56 overflow-y-auto rounded-box border border-base-300 bg-base-100">
                {sharedUsers.length === 0 ? (
                  <div className="p-3 text-sm text-base-content/70">
                    No users added yet.
                  </div>
                ) : (
                  <ul className="list p-2">
                    {sharedUsers.map((user) => (
                      <li key={user.id} className="list-row items-center">
                        <div className="list-col-grow">
                          <div className="font-medium text-sm">
                            {user.name || user.email || user.id}
                          </div>
                          <div className="text-xs text-base-content/60">
                            {user.email || user.id}
                            {user.role ? ` • ${user.role}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost text-error"
                          disabled={removingUserId === user.id}
                          onClick={() => {
                            void removeUser(user.id);
                          }}
                        >
                          {removingUserId === user.id
                            ? "Removing..."
                            : "Remove"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {error ? (
              <div
                role="alert"
                className="alert alert-error alert-soft mt-4 py-2 text-sm"
              >
                <span>{error}</span>
              </div>
            ) : null}

            <div className="mt-4 flex justify-end">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
