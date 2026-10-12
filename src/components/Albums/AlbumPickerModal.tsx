import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AlbumSummary } from "../../types";
import { useI18n } from "../../i18n";
import { useAlbumPickerLabels } from "../../i18n/albumPicker";
import { useConnectionContext } from "../../hooks/connectionContext";
import { AlbumPicker, type AlbumChoice } from "./AlbumPicker";

interface AlbumPickerModalProps {
  albums: AlbumSummary[];
  loading?: boolean;
  error?: string | null;
  initialValue?: AlbumChoice | null;
  title: string;
  subtitle?: string;
  allowEmpty?: boolean;
  emptyLabel?: string;
  requiresConnection?: boolean;
  onConfirm: (choice: AlbumChoice | null) => Promise<void>;
  onClose: () => void;
}

/** One modal/action flow for add-to-album and Import; callers own their existing mutations. */
export function AlbumPickerModal({
  albums,
  loading,
  error,
  initialValue = null,
  title,
  subtitle,
  allowEmpty,
  emptyLabel,
  requiresConnection = true,
  onConfirm,
  onClose,
}: AlbumPickerModalProps) {
  const { t } = useI18n();
  const labels = useAlbumPickerLabels();
  const { isOnline } = useConnectionContext();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [choice, setChoice] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const creating = !!choice?.newAlbumName;
  const needsConnection = requiresConnection || creating;
  const valid =
    creating ||
    (choice?.albumId
      ? albums.some((album) => album.id === choice.albumId && !album.isReadOnly)
      : allowEmpty);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const submit = async () => {
    if (busy || !valid || (needsConnection && isOnline !== true)) return;
    setBusy(true);
    setActionError(null);
    console.info("[album-picker] submitting", { creating, albumId: choice?.albumId });
    try {
      await onConfirm(choice);
      console.info("[album-picker] completed", { creating });
      onClose();
    } catch (error) {
      console.error("[album-picker] action failed", { albumId: choice?.albumId, error });
      setActionError(
        error instanceof Error ? error.message : typeof error === "string" ? error : labels.failed,
      );
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-box flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-y-auto">
        <h3 id={titleId} className="text-lg font-semibold">
          {title}
        </h3>
        {subtitle && <p className="mb-4 mt-1 text-sm text-base-content/70">{subtitle}</p>}
        <div className="my-4 min-h-0">
          <AlbumPicker
            albums={albums}
            value={choice}
            onChange={setChoice}
            loading={loading}
            disabled={busy}
            allowEmpty={allowEmpty}
            emptyLabel={emptyLabel}
          />
        </div>
        {needsConnection && isOnline !== true && (
          <p role="status" className="mb-3 text-sm text-base-content/70">
            {labels.offline}
          </p>
        )}
        {(actionError || error) && (
          <p role="alert" className="mb-3 text-sm text-error">
            {actionError || error}
          </p>
        )}
        <div className="modal-action">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            {t("selectionActions.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || loading || !valid || (needsConnection && isOnline !== true)}
            onClick={() => void submit()}
          >
            {busy
              ? labels.working
              : creating
                ? t("selectionActions.createAlbum")
                : t("selectionActions.addToAlbum")}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
