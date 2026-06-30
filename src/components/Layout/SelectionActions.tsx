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
import { useI18n } from "../../i18n";

type SelectionActionsProps = {
  selectedAssetIds: string[];
  selectedCount: number;
  fetchAlbumsForSelection?: () => Promise<AlbumSummary[]>;
  onAddSelectedToAlbum?: (input: { albumId?: string; newAlbumName?: string }) => Promise<void>;
  onCreateShareLinkForSelected?: () => Promise<string>;
  onSelectionActionCompleted?: () => void;
  onCopyProgress?: (progress: number | null) => void;
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
  onCopyProgress,
  disableCopy = false,
  variant = "topbar",
  modalZIndexClass = "z-[120]",
  stopPropagation = false,
}: SelectionActionsProps) {
  const [showAlbumModal, setShowAlbumModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [availableAlbums, setAvailableAlbums] = useState<AlbumSummary[]>([]);
  const [albumThumbnailMap, setAlbumThumbnailMap] = useState<Record<string, string>>({});
  const [isLoadingAlbums, setIsLoadingAlbums] = useState(false);
  const [selectedAlbumId, setSelectedAlbumId] = useState("");
  const [newAlbumName, setNewAlbumName] = useState("");
  const [isSubmittingAlbum, setIsSubmittingAlbum] = useState(false);
  const [isCreatingShare, setIsCreatingShare] = useState(false);
  const [isCopyingImages, setIsCopyingImages] = useState(false);
  const [isCopyingToLocalFolder, setIsCopyingToLocalFolder] = useState(false);
  const [localCopyStatusMessage, setLocalCopyStatusMessage] = useState<string | null>(null);
  const [showLocalCopyIssuesModal, setShowLocalCopyIssuesModal] = useState(false);
  const [showLocalCopyFallbackModal, setShowLocalCopyFallbackModal] = useState(false);
  const [localCopyFallbackPrompt, setLocalCopyFallbackPrompt] = useState<{
    originalUnavailableCount: number;
    cacheFallbackAvailableCount: number;
  } | null>(null);
  const [localCopyIssueDetails, setLocalCopyIssueDetails] = useState<{
    title: string;
    lines: string[];
  } | null>(null);
  const [localCopyHasFallbackStep, setLocalCopyHasFallbackStep] = useState(false);
  const [localCopyStep, setLocalCopyStep] = useState(2);
  const localCopyFallbackResolverRef = useRef<((decision: boolean) => void) | null>(null);
  const [shareLink, setShareLink] = useState("");
  const [linkCopyStatus, setLinkCopyStatus] = useState<"idle" | "success" | "error">("idle");
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const { t } = useI18n();
  const canRunSelectionAction = selectedAssetIds.length > 0;

  const getLocalCopyProgress = (
    currentStep: number,
    hasFallbackStep: boolean,
  ): {
    currentStep: number;
    stepLabels: string[];
  } => {
    const stepLabels = hasFallbackStep
      ? [
          t("selectionActions.stepPreparingDestination"),
          t("selectionActions.stepCopyingOriginals"),
          t("selectionActions.stepCachedFallback"),
          t("selectionActions.stepOpeningFolder"),
        ]
      : [
          t("selectionActions.stepPreparingDestination"),
          t("selectionActions.stepCopyingOriginals"),
          t("selectionActions.stepOpeningFolder"),
        ];

    return { currentStep, stepLabels };
  };

  const addButtonClass =
    variant === "preview" ? "btn btn-sm btn-outline" : "btn btn-sm btn-outline";
  const shareButtonClass =
    variant === "preview" ? "btn btn-sm btn-primary" : "btn btn-sm btn-primary";
  const shareMenuClass =
    "menu dropdown-content z-[130] mt-2 w-58 rounded-box border border-base-300 bg-base-100 p-1 shadow";

  const triggerAction = (event: MouseEvent<HTMLElement>, callback: () => void) => {
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
      const message = error instanceof Error ? error.message : "Could not load albums";
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
      const message = error instanceof Error ? error.message : "Failed to add to album";
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
        error instanceof Error ? error.message : "Failed to create album and add photos";
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
        error instanceof Error ? error.message : "Failed to create or copy share link";
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
      const message = error instanceof Error ? error.message : "Failed to copy images";
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
    setLocalCopyStep(1);
    setLocalCopyStatusMessage(t("selectionActions.statusCheckingLocalFolder"));
    try {
      const settings = await getSettings();
      const destinationFolder = settings.userLocalFolderPath.trim();
      if (!destinationFolder) {
        setLocalCopyIssueDetails({
          title: t("selectionActions.localFolderNotConfiguredTitle"),
          lines: [t("selectionActions.localFolderNotConfiguredLine")],
        });
        setShowLocalCopyIssuesModal(true);
        return;
      }

      await runCopyToDestinationFolder(destinationFolder);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to copy files to local folder";
      setSelectionError(message);
      setLocalCopyIssueDetails({
        title: t("selectionActions.copyFailedTitle"),
        lines: [message],
      });
      setShowLocalCopyIssuesModal(true);
      setLocalCopyStatusMessage(null);
    } finally {
      setIsCopyingToLocalFolder(false);
      if (!showLocalCopyIssuesModal && !showLocalCopyFallbackModal) {
        setLocalCopyStatusMessage((current) =>
          current === t("selectionActions.statusCompleted") ? current : null,
        );
      }
      setLocalCopyHasFallbackStep(false);
    }
  };

  const runCopyToDestinationFolder = async (destinationFolder: string) => {
    // Start progress tracking
    onCopyProgress?.(10);
    let progressValue = 10;
    const progressInterval = setInterval(() => {
      progressValue = Math.min(progressValue + Math.random() * 25, 90);
      onCopyProgress?.(progressValue);
    }, 200);

    try {
      let fallbackStepShown = false;
      setLocalCopyStep(2);
      setLocalCopyStatusMessage(t("selectionActions.statusCopyingOriginals"));
      const initial = await copyAssetsToLocalFolder(selectedAssetIds, destinationFolder, false);

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
        fallbackStepShown = true;
        setLocalCopyStep(3);
        setLocalCopyStatusMessage(t("selectionActions.statusWaitingFallback"));
        const useFallback = await requestCachedFallbackDecision({
          originalUnavailableCount: initial.originalUnavailableCount,
          cacheFallbackAvailableCount: initial.cacheFallbackAvailableCount,
        });

        if (useFallback) {
          setLocalCopyStatusMessage(t("selectionActions.statusCopyingCached"));
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
          setLocalCopyStatusMessage(t("selectionActions.statusSkippedCached"));
          skippedCount += initial.cacheFallbackAvailableCount;
        }
      }

      // Update progress to complete
      clearInterval(progressInterval);
      onCopyProgress?.(100);

      const totalCopied = copiedOriginalCount + copiedCachedCount;
      if (totalCopied > 0) {
        setLocalCopyStep(fallbackStepShown ? 4 : 3);
        setLocalCopyStatusMessage(t("selectionActions.statusOpeningFolder"));
        await openFolderInFileExplorer(destinationFolder);
        onSelectionActionCompleted?.();
      }

      // Clear progress after a short delay
      setTimeout(() => {
        onCopyProgress?.(null);
      }, 500);

      const hasIssues = skippedCount > 0 || failedCount > 0;
      if (hasIssues) {
        const issueLines = [
          t("selectionActions.originalsCopied", { count: copiedOriginalCount }),
          t("selectionActions.cachedCopied", { count: copiedCachedCount }),
          t("selectionActions.skippedCount", { count: skippedCount }),
          t("selectionActions.failedCount", { count: failedCount }),
        ];

        if (initial.originalUnavailableCount > 0) {
          issueLines.push(
            t("selectionActions.originalsNotAccessible", {
              count: initial.originalUnavailableCount,
            }),
          );
        }

        setLocalCopyIssueDetails({
          title: t("selectionActions.copyCompletedWithIssues"),
          lines: issueLines,
        });
        setShowLocalCopyIssuesModal(true);
      }

      if (!hasIssues) {
        setLocalCopyStatusMessage(t("selectionActions.statusCompleted"));
        window.setTimeout(() => {
          setLocalCopyStatusMessage(null);
        }, 1800);
      }
    } catch (error) {
      console.error("[SelectionActions] Copy error:", error);
      clearInterval(progressInterval);
      onCopyProgress?.(null);
      throw error;
    } finally {
      clearInterval(progressInterval);
    }
  };

  const submitCopyToUsbFolder = async () => {
    if (!canRunSelectionAction) {
      return;
    }

    setSelectionError(null);
    setIsCopyingToLocalFolder(true);
    setLocalCopyHasFallbackStep(false);
    setLocalCopyStep(1);
    setLocalCopyStatusMessage(t("selectionActions.statusSelectingFolder"));
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
        error instanceof Error ? error.message : "Failed to copy files to selected folder";
      setSelectionError(message);
      setLocalCopyIssueDetails({
        title: t("selectionActions.copyFailedTitle"),
        lines: [message],
      });
      setShowLocalCopyIssuesModal(true);
      setLocalCopyStatusMessage(null);
    } finally {
      setIsCopyingToLocalFolder(false);
      if (!showLocalCopyIssuesModal && !showLocalCopyFallbackModal) {
        setLocalCopyStatusMessage((current) =>
          current === t("selectionActions.statusCompleted") ? current : null,
        );
      }
      setLocalCopyHasFallbackStep(false);
    }
  };

  const shareSubject =
    selectedCount === 1
      ? t("selectionActions.subjectSingle")
      : t("selectionActions.subjectMultiple", { count: selectedCount });

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
        {t("selectionActions.addToAlbum")}
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
          {t("selectionActions.share")}
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
              {t("selectionActions.shareWithLink")}
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
                ? t("selectionActions.copyingImages")
                : t("selectionActions.copyImagesToClipboard")}
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
                ? t("selectionActions.copyingToLocalFolder")
                : t("selectionActions.openInFileExplorer")}
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
                ? t("selectionActions.copyingToSelectedFolder")
                : t("selectionActions.copyToUsb")}
            </button>
          </li>
        </ul>
      </details>

      {showAlbumModal ? (
        <div
          className={`fixed inset-0 ${modalZIndexClass} flex items-center justify-center bg-black/45 p-4`}
        >
          <div className="w-full max-w-xl rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
            <h3 className="m-0 text-lg font-semibold">{t("selectionActions.addToAlbum")}</h3>
            <p className="mb-4 mt-1 text-sm text-base-content/70">
              {t("selectionActions.addToAlbumSubtitle", { subject: shareSubject })}
            </p>

            <div className="mb-3">
              <label className="label px-0 pb-1 pt-0">
                <span className="label-text">{t("selectionActions.existingAlbum")}</span>
              </label>

              <details className="dropdown w-full">
                <summary className="btn btn-outline w-full justify-between">
                  {selectedAlbumId
                    ? (availableAlbums.find((album) => album.id === selectedAlbumId)?.albumName ??
                      t("selectionActions.selectAlbum"))
                    : t("selectionActions.selectAlbum")}
                </summary>
                <ul className="menu dropdown-content z-[130] mt-2 max-h-72 w-full overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow">
                  {availableAlbums.length === 0 ? (
                    <li>
                      <span className="text-base-content/60">
                        {isLoadingAlbums
                          ? t("selectionActions.loadingAlbums")
                          : t("selectionActions.noAlbumsAvailable")}
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
                              <span className="truncate max-w-52">{album.albumName}</span>
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
                {t("selectionActions.addToAlbum")}
              </button>
            </div>

            <div className="divider my-2" />

            <div className="mb-3">
              <label className="label px-0 pb-1 pt-0">
                <span className="label-text">{t("selectionActions.newAlbumName")}</span>
              </label>
              <input
                type="text"
                className="input input-bordered w-full"
                value={newAlbumName}
                onChange={(event) => setNewAlbumName(event.target.value)}
                placeholder={t("selectionActions.newAlbumPlaceholder")}
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
                {t("selectionActions.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!newAlbumName.trim() || isSubmittingAlbum}
                onClick={() => {
                  void submitCreateAlbum();
                }}
              >
                {t("selectionActions.createAlbum")}
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
            <h3 className="m-0 text-lg font-semibold">{t("selectionActions.shareWithLink")}</h3>
            <p className="mb-4 mt-1 text-sm text-base-content/70">
              {t("selectionActions.shareWithLinkSubtitle", { subject: shareSubject })}
            </p>

            {shareLink ? (
              <div className="mb-3">
                <label className="label px-0 pb-1 pt-0">
                  <span className="label-text">{t("selectionActions.shareLinkLabel")}</span>
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
                {t("selectionActions.close")}
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
                  ? t("selectionActions.creating")
                  : linkCopyStatus === "success"
                    ? t("selectionActions.linkCopied")
                    : linkCopyStatus === "error"
                      ? t("selectionActions.copyFailedShort")
                      : t("selectionActions.createLink")}
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
            <h3 className="m-0 text-lg font-semibold">{localCopyIssueDetails.title}</h3>
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
                {t("selectionActions.close")}
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
              {t("selectionActions.originalsUnavailableTitle")}
            </h3>
            <div className="mt-3 space-y-2 text-sm text-base-content/80">
              <p>
                {t("selectionActions.originalsUnavailableLine", {
                  count: localCopyFallbackPrompt.originalUnavailableCount,
                })}
              </p>
              <p>
                {t("selectionActions.cachedAvailableLine", {
                  count: localCopyFallbackPrompt.cacheFallbackAvailableCount,
                })}
              </p>
              <p>{t("selectionActions.copyCachedQuestion")}</p>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => resolveCachedFallbackDecision(false)}
              >
                {t("selectionActions.skipCachedCopy")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => resolveCachedFallbackDecision(true)}
              >
                {t("selectionActions.copyCachedFiles")}
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
                localCopyStep,
                localCopyHasFallbackStep,
              );
              const totalSteps = stepLabels.length;
              return (
                <>
                  <div className="badge badge-outline mb-2">
                    {t("selectionActions.stepLabel", { current: currentStep, total: totalSteps })}
                  </div>
                  <h3 className="m-0 text-lg font-semibold">
                    {t("selectionActions.copyInProgress")}
                  </h3>
                  <div className="mt-3 flex items-center gap-3 text-sm text-base-content/80">
                    <span className="loading loading-spinner loading-sm"></span>
                    <span>
                      {localCopyStatusMessage ?? t("selectionActions.copyingDefaultStatus")}
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
                              isActive ? "font-medium text-base-content" : "text-base-content/70"
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
