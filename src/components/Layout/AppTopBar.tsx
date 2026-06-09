import { X, Plus, Link, BookImage, Folder, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { copyAssetsToClipboard, getAssetThumbnail } from "../../api/tauri";
import type { Session } from "../../hooks/useSession";
import type { AlbumSummary } from "../../types";
import { Header } from "./Header";

interface AppTopBarProps {
  session: Session;
  onLogout: () => void;
  searchInput: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  selectedAssetIds?: string[];
  selectedCount?: number;
  onClearSelection?: () => void;
  onSelectAll?: () => void;
  fetchAlbumsForSelection?: () => Promise<AlbumSummary[]>;
  onAddSelectedToAlbum?: (input: {
    albumId?: string;
    newAlbumName?: string;
  }) => Promise<void>;
  onCreateShareLinkForSelected?: () => Promise<string>;
  onArchiveSelected?: () => Promise<void>;
}

export function AppTopBar({
  session,
  onLogout,
  searchInput,
  onSearchChange,
  searchPlaceholder,
  selectedAssetIds = [],
  selectedCount = 0,
  onClearSelection,
  onSelectAll,
  fetchAlbumsForSelection,
  onAddSelectedToAlbum,
  onCreateShareLinkForSelected,
  onArchiveSelected,
}: AppTopBarProps) {
  const [showAlbumModal, setShowAlbumModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [availableAlbums, setAvailableAlbums] = useState<AlbumSummary[]>([]);
  const [albumThumbnailMap, setAlbumThumbnailMap] = useState<
    Record<string, string>
  >({});
  const [isLoadingAlbums, setIsLoadingAlbums] = useState(false);
  const [selectedAlbumId, setSelectedAlbumId] = useState("");
  const [newAlbumName, setNewAlbumName] = useState("");
  const [isSubmittingAlbum, setIsSubmittingAlbum] = useState(false);
  const [isCreatingShare, setIsCreatingShare] = useState(false);
  const [isCopyingImages, setIsCopyingImages] = useState(false);
  const [shareLink, setShareLink] = useState("");
  const [isArchiving, setIsArchiving] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const canRunSelectionAction = selectedAssetIds.length > 0;

  useEffect(() => {
    if (selectedCount === 0) {
      setShowAlbumModal(false);
      setShowShareModal(false);
      setShowArchiveModal(false);
      setSelectionError(null);
      setShareLink("");
      setSelectedAlbumId("");
      setNewAlbumName("");
    }
  }, [selectedCount]);

  const openAlbumModal = async () => {
    setSelectionError(null);
    setShowAlbumModal(true);
    setShareLink("");

    if (!fetchAlbumsForSelection) {
      return;
    }

    setIsLoadingAlbums(true);
    try {
      const albums = await fetchAlbumsForSelection();
      setAvailableAlbums(albums);

      const thumbnails = await Promise.all(
        albums.map(async (album) => {
          if (!album.albumThumbnailAssetId) {
            return [album.id, null] as const;
          }

          try {
            const src = await getAssetThumbnail(album.albumThumbnailAssetId);
            return [album.id, src] as const;
          } catch {
            return [album.id, null] as const;
          }
        }),
      );

      const nextMap: Record<string, string> = {};
      for (const [albumId, src] of thumbnails) {
        if (src) {
          nextMap[albumId] = src;
        }
      }
      setAlbumThumbnailMap(nextMap);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not load albums";
      setSelectionError(message);
    } finally {
      setIsLoadingAlbums(false);
    }
  };

  const submitAddToAlbum = async () => {
    if (!onAddSelectedToAlbum || !selectedAlbumId) {
      return;
    }

    setSelectionError(null);
    setIsSubmittingAlbum(true);
    try {
      await onAddSelectedToAlbum({ albumId: selectedAlbumId });
      setShowAlbumModal(false);
      setSelectedAlbumId("");
      onClearSelection?.();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add to album";
      setSelectionError(message);
    } finally {
      setIsSubmittingAlbum(false);
    }
  };

  const submitCreateAlbum = async () => {
    if (!onAddSelectedToAlbum || !newAlbumName.trim()) {
      return;
    }

    setSelectionError(null);
    setIsSubmittingAlbum(true);
    try {
      await onAddSelectedToAlbum({ newAlbumName: newAlbumName.trim() });
      setShowAlbumModal(false);
      setNewAlbumName("");
      onClearSelection?.();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to create album and add photos";
      setSelectionError(message);
    } finally {
      setIsSubmittingAlbum(false);
    }
  };

  const submitCreateShareLink = async () => {
    if (!onCreateShareLinkForSelected || !canRunSelectionAction) {
      return;
    }

    setSelectionError(null);
    setIsCreatingShare(true);
    try {
      const link = await onCreateShareLinkForSelected();
      setShareLink(link);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create share link";
      setSelectionError(message);
    } finally {
      setIsCreatingShare(false);
    }
  };

  const submitCopyImagesToClipboard = async () => {
    if (!canRunSelectionAction) {
      return;
    }

    setSelectionError(null);
    setIsCopyingImages(true);

    try {
      await copyAssetsToClipboard(selectedAssetIds);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to copy images";
      setSelectionError(message);
    } finally {
      setIsCopyingImages(false);
    }
  };

  const submitArchive = async () => {
    if (!onArchiveSelected || !canRunSelectionAction) {
      return;
    }

    setSelectionError(null);
    setIsArchiving(true);
    try {
      await onArchiveSelected();
      setShowArchiveModal(false);
      onClearSelection?.();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to archive photos";
      setSelectionError(message);
    } finally {
      setIsArchiving(false);
    }
  };

  if (selectedCount > 0) {
    return (
      <>
        <header className="navbar border-b border-base-300 bg-base-100 px-3 sm:px-4">
          <div className="navbar-start gap-4">
            <button
              type="button"
              className="btn btn-sm btn-outline gap-1"
              onClick={onClearSelection}
            >
              <X size={16} />
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-neutral"
              onClick={onSelectAll}
            >
              Select All
            </button>
            <p className="text-sm font-semibold text-base-content">
              {selectedCount} selected
            </p>
          </div>

          <div className="navbar-end gap-2">
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => {
                void openAlbumModal();
              }}
            >
              <BookImage size={16} />
              Add to album
            </button>
            <details className="dropdown dropdown-end">
              <summary className="btn btn-sm btn-primary">
                <Link size={16} />
                Share
              </summary>
              <ul className="menu dropdown-content z-[130] mt-2 w-58 rounded-box border border-base-300 bg-base-100 p-1 shadow">
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectionError(null);
                      setShareLink("");
                      setShowShareModal(true);
                    }}
                  >
                    <Link size={14} />
                    Share with a link
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    disabled={isCopyingImages}
                    onClick={() => {
                      void submitCopyImagesToClipboard();
                    }}
                  >
                    <BookImage size={14} />
                    {isCopyingImages
                      ? "Copying images..."
                      : "Copy images to clipboard"}
                  </button>
                </li>
                <li>
                  <button type="button" disabled className="opacity-40">
                    <Folder size={14} />
                    Open in file explorer
                  </button>
                </li>
              </ul>
            </details>
            <div className="h-5 w-px bg-base-300" />
            <button
              type="button"
              className="btn btn-sm btn-error"
              onClick={() => {
                setSelectionError(null);
                setShowArchiveModal(true);
              }}
            >
              <Trash2 size={16} />
              Delete
            </button>
          </div>
        </header>

        {showAlbumModal ? (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4">
            <div className="w-full max-w-xl rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
              <h3 className="m-0 text-lg font-semibold">Add to album</h3>
              <p className="mb-4 mt-1 text-sm text-base-content/70">
                Add {selectedCount} selected photo{selectedCount > 1 ? "s" : ""}{" "}
                to an existing album or create a new one.
              </p>

              <div className="mb-3">
                <label className="label px-0 pb-1 pt-0">
                  <span className="label-text">Existing album</span>
                </label>

                <details className="dropdown w-full">
                  <summary className="btn btn-outline w-full justify-between">
                    {selectedAlbumId
                      ? (availableAlbums.find(
                          (album) => album.id === selectedAlbumId,
                        )?.albumName ?? "Select album")
                      : "Select album"}
                  </summary>
                  <ul className="menu dropdown-content z-[130] mt-2 max-h-72 w-full overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow">
                    {availableAlbums.length === 0 ? (
                      <li>
                        <span className="text-base-content/60">
                          {isLoadingAlbums
                            ? "Loading albums..."
                            : "No albums available"}
                        </span>
                      </li>
                    ) : (
                      availableAlbums.map((album) => {
                        const isActive = selectedAlbumId === album.id;
                        const thumbSrc = albumThumbnailMap[album.id];

                        return (
                          <li key={album.id}>
                            <button
                              type="button"
                              className={`justify-between ${isActive ? "menu-active" : ""}`}
                              onClick={() => {
                                setSelectedAlbumId(album.id);
                              }}
                            >
                              <div className="flex items-center gap-2">
                                {thumbSrc ? (
                                  <span className="avatar">
                                    <span className="w-8 rounded-box overflow-hidden">
                                      <img
                                        src={thumbSrc}
                                        alt={album.albumName}
                                      />
                                    </span>
                                  </span>
                                ) : (
                                  <span className="avatar placeholder">
                                    <span className="w-8 rounded-box bg-base-300 text-[10px] text-base-content/70">
                                      {album.albumName
                                        .slice(0, 1)
                                        .toUpperCase()}
                                    </span>
                                  </span>
                                )}
                                <span className="truncate max-w-52">
                                  {album.albumName}
                                </span>
                              </div>
                              <span className="badge badge-sm badge-ghost">
                                {album.assetCount ?? 0}
                              </span>
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                </details>
              </div>

              <div className="mb-4 flex gap-2">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!selectedAlbumId || isSubmittingAlbum}
                  onClick={() => {
                    void submitAddToAlbum();
                  }}
                >
                  <Plus size={16} />
                  Add to album
                </button>
              </div>

              <div className="divider my-2" />

              <div className="mb-3">
                <label className="label px-0 pb-1 pt-0">
                  <span className="label-text">New album name</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered w-full"
                  value={newAlbumName}
                  onChange={(event) => setNewAlbumName(event.target.value)}
                  placeholder="Summer trip"
                  disabled={isSubmittingAlbum}
                />
              </div>

              {selectionError ? (
                <div className="alert alert-error mb-3 py-2 text-sm">
                  <span>{selectionError}</span>
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowAlbumModal(false)}
                  disabled={isSubmittingAlbum}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!newAlbumName.trim() || isSubmittingAlbum}
                  onClick={() => {
                    void submitCreateAlbum();
                  }}
                >
                  Create album
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showShareModal ? (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4">
            <div className="w-full max-w-lg rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
              <h3 className="m-0 text-lg font-semibold">Share with a link</h3>
              <p className="mb-4 mt-1 text-sm text-base-content/70">
                Generate a share link for {selectedCount} selected photo
                {selectedCount > 1 ? "s" : ""}.
              </p>

              {shareLink ? (
                <div className="mb-3">
                  <label className="label px-0 pb-1 pt-0">
                    <span className="label-text">Share link</span>
                  </label>
                  <input
                    type="text"
                    readOnly
                    className="input input-bordered w-full"
                    value={shareLink}
                  />
                </div>
              ) : null}

              {selectionError ? (
                <div className="alert alert-error mb-3 py-2 text-sm">
                  <span>{selectionError}</span>
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowShareModal(false)}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    void submitCreateShareLink();
                  }}
                  disabled={isCreatingShare}
                >
                  {isCreatingShare ? "Creating..." : "Create link"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showArchiveModal ? (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4">
            <div className="w-full max-w-md rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
              <h3 className="m-0 text-lg font-semibold">Archive photos?</h3>
              <p className="mb-4 mt-1 text-sm text-base-content/70">
                This will archive {selectedCount} selected photo
                {selectedCount > 1 ? "s" : ""}. You can restore them later.
              </p>

              {selectionError ? (
                <div className="alert alert-error mb-3 py-2 text-sm">
                  <span>{selectionError}</span>
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowArchiveModal(false)}
                  disabled={isArchiving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-error"
                  onClick={() => {
                    void submitArchive();
                  }}
                  disabled={isArchiving}
                >
                  {isArchiving ? "Archiving..." : "Archive"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <Header
      searchInput={searchInput}
      onSearchChange={onSearchChange}
      serverUrl={session.serverUrl}
      userId={session.userId}
      userName={session.userName}
      onLogout={onLogout}
      searchPlaceholder={searchPlaceholder}
    />
  );
}
