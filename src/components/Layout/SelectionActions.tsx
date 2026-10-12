import { Clock, Copy, Folder, Link, BookImage, MoreHorizontal, Trash2 } from "lucide-react";
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
  openFolderInFileExplorer,
} from "../../api/tauri";
import type { AlbumSummary } from "../../types";
import { useI18n } from "../../i18n";
import { requestFixTime } from "../../api/time";
import { useSearchTimeI18n } from "../../i18n/searchTime";
import { AlbumPickerModal } from "../Albums/AlbumPickerModal";
import type { AlbumChoice } from "../Albums/AlbumPicker";
import { useAlbumPickerLabels } from "../../i18n/albumPicker";

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
  showTimeButton?: boolean;
  onDeleteSelected?: () => void;
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
  showTimeButton = true,
  onDeleteSelected,
}: SelectionActionsProps) {
  const [showAlbumModal, setShowAlbumModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [availableAlbums, setAvailableAlbums] = useState<AlbumSummary[]>([]);
  const [isLoadingAlbums, setIsLoadingAlbums] = useState(false);
  const [albumLoadError, setAlbumLoadError] = useState<string | null>(null);
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
  const tTime = useSearchTimeI18n();
  const albumLabels = useAlbumPickerLabels();
  const moreMenuRef = useRef<HTMLDetailsElement>(null);
  const shareMenuRef = useRef<HTMLDetailsElement>(null);

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
    variant === "preview"
      ? "btn btn-sm btn-ghost border border-white/15 bg-zinc-900 text-white hover:bg-zinc-800"
      : "btn btn-sm btn-outline";
  const shareButtonClass = variant === "preview" ? addButtonClass : "btn btn-sm btn-primary";
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
    setAlbumLoadError(null);
    try {
      const albums = fetchAlbumsForSelection
        ? await fetchAlbumsForSelection()
        : await fetchAlbums();
      setAvailableAlbums(albums.filter((album) => !album.isReadOnly));
      console.info("[album-picker] loaded cached albums", { count: albums.length });
    } catch (error) {
      console.error("[album-picker] cached album load failed", error);
      setAlbumLoadError(error instanceof Error ? error.message : albumLabels.loadFailed);
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

  const submitAlbumChoice = async (choice: AlbumChoice | null) => {
    if (!canRunSelectionAction || !choice) return;
    if (onAddSelectedToAlbum) {
      await onAddSelectedToAlbum(choice);
    } else if (choice.albumId) {
      await addAssetsToAlbum(choice.albumId, selectedAssetIds);
    } else if (choice.newAlbumName) {
      await createAlbumWithAssets(choice.newAlbumName, selectedAssetIds);
    }
    onSelectionActionCompleted?.();
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
        aria-label={t("selectionActions.addToAlbum")}
        title={t("selectionActions.addToAlbum")}
        disabled={!canRunSelectionAction}
        onClick={(event) => {
          triggerAction(event, () => {
            void openAlbumModal();
          });
        }}
      >
        <BookImage size={16} />
        <span className={variant === "preview" ? "hidden lg:inline" : ""}>
          {t("selectionActions.addToAlbum")}
        </span>
      </button>

      <details
        ref={shareMenuRef}
        className="dropdown dropdown-end"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget) && shareMenuRef.current)
            shareMenuRef.current.open = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && shareMenuRef.current) {
            event.stopPropagation();
            shareMenuRef.current.open = false;
            shareMenuRef.current.querySelector("summary")?.focus();
          }
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button") && shareMenuRef.current)
            shareMenuRef.current.open = false;
          if (stopPropagation) {
            event.stopPropagation();
          }
        }}
      >
        <summary
          className={shareButtonClass}
          aria-label={t("selectionActions.share")}
          title={t("selectionActions.share")}
        >
          <Link size={16} />
          <span className={variant === "preview" ? "hidden lg:inline" : ""}>
            {t("selectionActions.share")}
          </span>
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

      {showTimeButton || onDeleteSelected ? (
        <details
          ref={moreMenuRef}
          className="dropdown dropdown-end ml-auto"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget) && moreMenuRef.current)
              moreMenuRef.current.open = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && moreMenuRef.current) {
              event.stopPropagation();
              moreMenuRef.current.open = false;
              moreMenuRef.current.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            className="btn btn-sm btn-ghost btn-square"
            aria-label={t("photoGrid.moreActionsAria")}
          >
            <MoreHorizontal size={18} />
          </summary>
          <ul className={shareMenuClass}>
            {showTimeButton && (
              <li>
                <button
                  type="button"
                  data-test="selection-update-time"
                  disabled={!canRunSelectionAction}
                  onClick={(event) =>
                    triggerAction(event, () => {
                      if (moreMenuRef.current) moreMenuRef.current.open = false;
                      requestFixTime(selectedAssetIds);
                    })
                  }
                >
                  <Clock size={16} />
                  {tTime("updateTime")}
                </button>
              </li>
            )}
            {onDeleteSelected && (
              <li>
                <button
                  type="button"
                  disabled={!canRunSelectionAction}
                  onClick={(event) =>
                    triggerAction(event, () => {
                      if (moreMenuRef.current) moreMenuRef.current.open = false;
                      onDeleteSelected();
                    })
                  }
                >
                  <Trash2 size={16} />
                  {t("topBar.delete")}
                </button>
              </li>
            )}
          </ul>
        </details>
      ) : null}

      {showAlbumModal ? (
        <AlbumPickerModal
          title={t("selectionActions.addToAlbum")}
          subtitle={t("selectionActions.addToAlbumSubtitle", { subject: shareSubject })}
          albums={availableAlbums}
          loading={isLoadingAlbums}
          error={albumLoadError}
          onConfirm={submitAlbumChoice}
          onClose={() => setShowAlbumModal(false)}
        />
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
