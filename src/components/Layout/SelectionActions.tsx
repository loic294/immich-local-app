import { Check, Copy, Folder, Link, Plus, BookImage } from "lucide-react";
import { useRef, useState, type MouseEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  addAssetsToAlbum,
  copyAssetsToLocalFolder,
  copyAssetsToClipboard,
  copyTextToClipboard,
  createAlbumWithAssets,
  createShareLinkForAssets,
  fetchAlbums,
  getSettings,
  getAssetThumbnail,
  openFolderInFileExplorer,
} from "../../api/tauri";
import type { AlbumSummary } from "../../types";

type SelectionActionsProps = {
  selectedAssetIds: string[];
  selectedCount: number;
  fetchAlbumsForSelection?: () => Promise<AlbumSummary[]>;
  onAddSelectedToAlbum?: (input: {
    albumId?: string;
    newAlbumName?: string;
  }) => Promise<void>;
  onCreateShareLinkForSelected?: () => Promise<string>;
  onSelectionActionCompleted?: () => void;
  disableCopy?: boolean;
  variant?: "topbar" | "preview";
  modalZIndexClass?: string;
  stopPropagation?: boolean;
};

export function SelectionActions({
  selectedAssetIds,
  selectedCount,
  fetchAlbumsForSelection,
  onAddSelectedToAlbum,
  onCreateShareLinkForSelected,
  onSelectionActionCompleted,
  disableCopy = false,
  variant = "topbar",
  modalZIndexClass = "z-[120]",
  stopPropagation = false,
}: SelectionActionsProps) {
  const [showAlbumModal, setShowAlbumModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
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
  const [isCopyingToLocalFolder, setIsCopyingToLocalFolder] = useState(false);
  const [localCopyStatusMessage, setLocalCopyStatusMessage] = useState<
    string | null
  >(null);
  const [showLocalCopyIssuesModal, setShowLocalCopyIssuesModal] =
    useState(false);
  const [showLocalCopyFallbackModal, setShowLocalCopyFallbackModal] =
    useState(false);
  const [localCopyFallbackPrompt, setLocalCopyFallbackPrompt] = useState<{
    originalUnavailableCount: number;
    cacheFallbackAvailableCount: number;
  } | null>(null);
  const [localCopyIssueDetails, setLocalCopyIssueDetails] = useState<{
    title: string;
    lines: string[];
  } | null>(null);
  const [localCopyHasFallbackStep, setLocalCopyHasFallbackStep] =
    useState(false);
  const localCopyFallbackResolverRef = useRef<
    ((decision: boolean) => void) | null
  >(null);
  const [shareLink, setShareLink] = useState("");
  const [linkCopyStatus, setLinkCopyStatus] = useState<
    "idle" | "success" | "error"
  >("idle");
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const canRunSelectionAction = selectedAssetIds.length > 0;

  const getLocalCopyProgress = (
    status: string | null,
    hasFallbackStep: boolean,
  ): {
    currentStep: number;
    stepLabels: string[];
  } => {
    const stepLabels = hasFallbackStep
      ? [
          "Preparing destination",
          "Copying accessible originals",
          "Optional cached fallback",
          "Opening destination folder",
        ]
      : [
          "Preparing destination",
          "Copying accessible originals",
          "Opening destination folder",
        ];

    if (!status) {
      return { currentStep: 2, stepLabels };
    }

    if (status.includes("Checking local folder")) {
      return { currentStep: 1, stepLabels };
    }

    if (status.includes("Copying accessible original")) {
      return { currentStep: 2, stepLabels };
    }

    if (hasFallbackStep) {
      if (
        status.includes("Waiting for fallback") ||
        status.includes("cached fallback") ||
        status.includes("Skipped cached fallback")
      ) {
        return { currentStep: 3, stepLabels };
      }

      if (status.includes("Opening destination folder")) {
        return { currentStep: 4, stepLabels };
      }
    } else if (status.includes("Opening destination folder")) {
      return { currentStep: 3, stepLabels };
    }

    return { currentStep: 2, stepLabels };
  };

  const addButtonClass =
    variant === "preview"
      ? "btn btn-sm btn-ghost border border-white/15 bg-zinc-900 text-white"
      : "btn btn-sm btn-outline";
  const shareButtonClass =
    variant === "preview"
      ? "btn btn-sm btn-ghost border border-white/15 bg-zinc-900 text-white"
      : "btn btn-sm btn-primary";
  const shareMenuClass =
    "menu dropdown-content z-[130] mt-2 w-58 rounded-box border border-base-300 bg-base-100 p-1 shadow";

  const triggerAction = (
    event: MouseEvent<HTMLElement>,
    callback: () => void,
  ) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
    callback();
  };

  const loadAlbumsForModal = async () => {
    setIsLoadingAlbums(true);
    try {
      const albums = fetchAlbumsForSelection
        ? await fetchAlbumsForSelection()
        : await fetchAlbums();
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

  const openAlbumModal = async () => {
    setSelectionError(null);
    setShowAlbumModal(true);
    setShareLink("");
    await loadAlbumsForModal();
  };

  const submitAddToAlbum = async () => {
    if (!canRunSelectionAction || !selectedAlbumId) {
      return;
    }

    setSelectionError(null);
    setIsSubmittingAlbum(true);
    try {
      if (onAddSelectedToAlbum) {
        await onAddSelectedToAlbum({ albumId: selectedAlbumId });
      } else {
        await addAssetsToAlbum(selectedAlbumId, selectedAssetIds);
      }
      setShowAlbumModal(false);
      setSelectedAlbumId("");
      onSelectionActionCompleted?.();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to add to album";
      setSelectionError(message);
    } finally {
      setIsSubmittingAlbum(false);
    }
  };

  const submitCreateAlbum = async () => {
    const albumName = newAlbumName.trim();
    if (!canRunSelectionAction || !albumName) {
      return;
    }

    setSelectionError(null);
    setIsSubmittingAlbum(true);
    try {
      if (onAddSelectedToAlbum) {
        await onAddSelectedToAlbum({ newAlbumName: albumName });
      } else {
        await createAlbumWithAssets(albumName, selectedAssetIds);
      }
      setShowAlbumModal(false);
      setNewAlbumName("");
      onSelectionActionCompleted?.();
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
    if (!canRunSelectionAction) {
      return;
    }

    setSelectionError(null);
    setIsCreatingShare(true);
    try {
      const link =
        shareLink.length > 0
          ? shareLink
          : onCreateShareLinkForSelected
            ? await onCreateShareLinkForSelected()
            : await createShareLinkForAssets(selectedAssetIds);
      setShareLink(link);

      await copyTextToClipboard(link);
      setLinkCopyStatus("success");
      window.setTimeout(() => {
        setLinkCopyStatus("idle");
      }, 1600);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to create or copy share link";
      setSelectionError(message);
      setLinkCopyStatus("error");
      window.setTimeout(() => {
        setLinkCopyStatus("idle");
      }, 2000);
    } finally {
      setIsCreatingShare(false);
    }
  };

  const submitCopyImagesToClipboard = async () => {
    if (!canRunSelectionAction || disableCopy) {
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

  const requestCachedFallbackDecision = (input: {
    originalUnavailableCount: number;
    cacheFallbackAvailableCount: number;
  }): Promise<boolean> => {
    setLocalCopyFallbackPrompt(input);
    setShowLocalCopyFallbackModal(true);
    return new Promise((resolve) => {
      localCopyFallbackResolverRef.current = resolve;
    });
  };

  const resolveCachedFallbackDecision = (decision: boolean) => {
    const resolve = localCopyFallbackResolverRef.current;
    localCopyFallbackResolverRef.current = null;
    setShowLocalCopyFallbackModal(false);
    setLocalCopyFallbackPrompt(null);
    if (resolve) {
      resolve(decision);
    }
  };

  const submitOpenInFileExplorer = async () => {
    if (!canRunSelectionAction) {
      return;
    }

    setSelectionError(null);
    setIsCopyingToLocalFolder(true);
    setLocalCopyHasFallbackStep(false);
    setLocalCopyStatusMessage("Checking local folder setting...");
    try {
      const settings = await getSettings();
      const destinationFolder = settings.userLocalFolderPath.trim();
      if (!destinationFolder) {
        setLocalCopyIssueDetails({
          title: "Local folder is not configured",
          lines: [
            "Set a Local Files Folder in Settings before using Open in file explorer.",
          ],
        });
        setShowLocalCopyIssuesModal(true);
        return;
      }

      await runCopyToDestinationFolder(destinationFolder);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to copy files to local folder";
      setSelectionError(message);
      setLocalCopyIssueDetails({
        title: "Copy failed",
        lines: [message],
      });
      setShowLocalCopyIssuesModal(true);
      setLocalCopyStatusMessage(null);
    } finally {
      setIsCopyingToLocalFolder(false);
      if (!showLocalCopyIssuesModal && !showLocalCopyFallbackModal) {
        setLocalCopyStatusMessage((current) =>
          current === "Copy completed successfully." ? current : null,
        );
      }
      setLocalCopyHasFallbackStep(false);
    }
  };

  const runCopyToDestinationFolder = async (destinationFolder: string) => {
    setLocalCopyStatusMessage("Copying accessible original files...");
    const initial = await copyAssetsToLocalFolder(
      selectedAssetIds,
      destinationFolder,
      false,
    );

    let copiedOriginalCount = initial.copiedOriginalCount;
    let copiedCachedCount = initial.copiedCachedCount;
    let skippedCount = initial.skippedCount;
    let failedCount = initial.failedCount;

    if (
      initial.hasFallbackCandidates &&
      initial.cacheFallbackAvailableCount > 0 &&
      initial.fallbackCandidateAssetIds.length > 0
    ) {
      setLocalCopyHasFallbackStep(true);
      setLocalCopyStatusMessage(
        "Some originals are unavailable. Waiting for fallback confirmation...",
      );
      const useFallback = await requestCachedFallbackDecision({
        originalUnavailableCount: initial.originalUnavailableCount,
        cacheFallbackAvailableCount: initial.cacheFallbackAvailableCount,
      });

      if (useFallback) {
        setLocalCopyStatusMessage("Copying cached fallback files...");
        const fallback = await copyAssetsToLocalFolder(
          initial.fallbackCandidateAssetIds,
          destinationFolder,
          true,
        );
        copiedOriginalCount += fallback.copiedOriginalCount;
        copiedCachedCount += fallback.copiedCachedCount;
        skippedCount += fallback.skippedCount;
        failedCount += fallback.failedCount;
      } else {
        setLocalCopyStatusMessage("Skipped cached fallback copy.");
        skippedCount += initial.cacheFallbackAvailableCount;
      }
    }

    const totalCopied = copiedOriginalCount + copiedCachedCount;
    if (totalCopied > 0) {
      setLocalCopyStatusMessage("Opening destination folder...");
      await openFolderInFileExplorer(destinationFolder);
      onSelectionActionCompleted?.();
    }

    const hasIssues = skippedCount > 0 || failedCount > 0;
    if (hasIssues) {
      const issueLines = [
        `Originals copied: ${copiedOriginalCount}`,
        `Cached copied: ${copiedCachedCount}`,
        `Skipped: ${skippedCount}`,
        `Failed: ${failedCount}`,
      ];

      if (initial.originalUnavailableCount > 0) {
        issueLines.push(
          `${initial.originalUnavailableCount} original file(s) were not accessible during this operation.`,
        );
      }

      setLocalCopyIssueDetails({
        title: "Copy completed with issues",
        lines: issueLines,
      });
      setShowLocalCopyIssuesModal(true);
    }

    if (!hasIssues) {
      setLocalCopyStatusMessage("Copy completed successfully.");
      window.setTimeout(() => {
        setLocalCopyStatusMessage(null);
      }, 1800);
    }
  };

  const submitCopyToUsbFolder = async () => {
    if (!canRunSelectionAction) {
      return;
    }

    setSelectionError(null);
    setIsCopyingToLocalFolder(true);
    setLocalCopyHasFallbackStep(false);
    setLocalCopyStatusMessage("Selecting destination folder...");
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (!selected || Array.isArray(selected)) {
        setLocalCopyStatusMessage(null);
        return;
      }

      await runCopyToDestinationFolder(selected);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to copy files to selected folder";
      setSelectionError(message);
      setLocalCopyIssueDetails({
        title: "Copy failed",
        lines: [message],
      });
      setShowLocalCopyIssuesModal(true);
      setLocalCopyStatusMessage(null);
    } finally {
      setIsCopyingToLocalFolder(false);
      if (!showLocalCopyIssuesModal && !showLocalCopyFallbackModal) {
        setLocalCopyStatusMessage((current) =>
          current === "Copy completed successfully." ? current : null,
        );
      }
      setLocalCopyHasFallbackStep(false);
    }
  };

  const shareSubject =
    selectedCount === 1
      ? "this photo"
      : `${selectedCount} selected photo${selectedCount > 1 ? "s" : ""}`;

  return (
    <>
      <button
        type="button"
        className={addButtonClass}
        onClick={(event) => {
          triggerAction(event, () => {
            void openAlbumModal();
          });
        }}
      >
        <BookImage size={16} />
        Add to album
      </button>

      <details
        className="dropdown dropdown-end"
        onClick={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
        }}
      >
        <summary className={shareButtonClass}>
          <Link size={16} />
          Share
        </summary>
        <ul className={shareMenuClass}>
          <li>
            <button
              type="button"
              onClick={() => {
                setSelectionError(null);
                setShareLink("");
                setLinkCopyStatus("idle");
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
              disabled={isCopyingImages || disableCopy}
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
            <button
              type="button"
              disabled={isCopyingToLocalFolder}
              onClick={() => {
                void submitOpenInFileExplorer();
              }}
            >
              <Folder size={14} />
              {isCopyingToLocalFolder
                ? "Copying to local folder..."
                : "Open in File Explorer"}
            </button>
          </li>
          <li>
            <button
              type="button"
              disabled={isCopyingToLocalFolder}
              onClick={() => {
                void submitCopyToUsbFolder();
              }}
            >
              <Copy size={14} />
              {isCopyingToLocalFolder
                ? "Copying to selected folder..."
                : "Copy to USB stick/folder"}
            </button>
          </li>
        </ul>
      </details>

      {showAlbumModal ? (
        <div
          className={`fixed inset-0 ${modalZIndexClass} flex items-center justify-center bg-black/45 p-4`}
        >
          <div className="w-full max-w-xl rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
            <h3 className="m-0 text-lg font-semibold">Add to album</h3>
            <p className="mb-4 mt-1 text-sm text-base-content/70">
              Add {shareSubject} to an existing album or create a new one.
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
                                    <img src={thumbSrc} alt={album.albumName} />
                                  </span>
                                </span>
                              ) : (
                                <span className="avatar placeholder">
                                  <span className="w-8 rounded-box bg-base-300 text-[10px] text-base-content/70">
                                    {album.albumName.slice(0, 1).toUpperCase()}
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
        <div
          className={`fixed inset-0 ${modalZIndexClass} flex items-center justify-center bg-black/45 p-4`}
        >
          <div className="w-full max-w-lg rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
            <h3 className="m-0 text-lg font-semibold">Share with a link</h3>
            <p className="mb-4 mt-1 text-sm text-base-content/70">
              Generate a share link for {shareSubject}.
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
                {isCreatingShare
                  ? "Creating..."
                  : linkCopyStatus === "success"
                    ? "Link copied!"
                    : linkCopyStatus === "error"
                      ? "Copy failed"
                      : "Create link"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showLocalCopyIssuesModal && localCopyIssueDetails ? (
        <div
          className={`fixed inset-0 ${modalZIndexClass} flex items-center justify-center bg-black/45 p-4`}
        >
          <div className="w-full max-w-lg rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
            <h3 className="m-0 text-lg font-semibold">
              {localCopyIssueDetails.title}
            </h3>
            <div className="mt-3 space-y-2 text-sm text-base-content/80">
              {localCopyIssueDetails.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowLocalCopyIssuesModal(false);
                  setLocalCopyIssueDetails(null);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showLocalCopyFallbackModal && localCopyFallbackPrompt ? (
        <div
          className={`fixed inset-0 ${modalZIndexClass} flex items-center justify-center bg-black/45 p-4`}
        >
          <div className="w-full max-w-lg rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
            <h3 className="m-0 text-lg font-semibold">
              Original files unavailable
            </h3>
            <div className="mt-3 space-y-2 text-sm text-base-content/80">
              <p>
                {localCopyFallbackPrompt.originalUnavailableCount} original
                file(s) could not be accessed or downloaded.
              </p>
              <p>
                {localCopyFallbackPrompt.cacheFallbackAvailableCount} cached
                file(s) are available.
              </p>
              <p>Do you want to copy cached files instead?</p>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => resolveCachedFallbackDecision(false)}
              >
                Skip cached copy
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => resolveCachedFallbackDecision(true)}
              >
                Copy cached files
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isCopyingToLocalFolder && !showLocalCopyFallbackModal ? (
        <div
          className={`fixed inset-0 ${modalZIndexClass} flex items-center justify-center bg-black/45 p-4`}
        >
          <div className="w-full max-w-md rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
            {(() => {
              const { currentStep, stepLabels } = getLocalCopyProgress(
                localCopyStatusMessage,
                localCopyHasFallbackStep,
              );
              const totalSteps = stepLabels.length;
              return (
                <>
                  <div className="badge badge-outline mb-2">
                    Step {currentStep}/{totalSteps}
                  </div>
                  <h3 className="m-0 text-lg font-semibold">
                    Copy in progress
                  </h3>
                  <div className="mt-3 flex items-center gap-3 text-sm text-base-content/80">
                    <span className="loading loading-spinner loading-sm"></span>
                    <span>
                      {localCopyStatusMessage ??
                        "Copying accessible files to your local folder..."}
                    </span>
                  </div>
                  <ul className="list mt-4 rounded-box border border-base-300/60 bg-base-200/40">
                    {stepLabels.map((label, index) => {
                      const stepNumber = index + 1;
                      const isActive = stepNumber === currentStep;
                      const isDone = stepNumber < currentStep;

                      return (
                        <li key={label} className="list-row py-2">
                          <span
                            className={`status ${
                              isDone
                                ? "status-success"
                                : isActive
                                  ? "status-info"
                                  : "status-neutral"
                            }`}
                          ></span>
                          <span
                            className={`text-sm ${
                              isActive
                                ? "font-medium text-base-content"
                                : "text-base-content/70"
                            }`}
                          >
                            {label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              );
            })()}
          </div>
        </div>
      ) : null}
    </>
  );
}
