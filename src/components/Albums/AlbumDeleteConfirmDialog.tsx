import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "../../i18n";
import { useAlbumManagementLabels } from "../../i18n/albumManagement";

interface AlbumDeleteConfirmDialogProps {
  albumName: string;
  shared: boolean;
  online: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function AlbumDeleteConfirmDialog({
  albumName,
  shared,
  online,
  busy,
  error,
  onConfirm,
  onClose,
}: AlbumDeleteConfirmDialogProps) {
  const { t } = useI18n();
  const labels = useAlbumManagementLabels();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-box max-w-lg">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-1 shrink-0 text-error" size={24} aria-hidden="true" />
          <h3 id={titleId} className="text-lg font-semibold">
            {labels.deleteTitle}
          </h3>
        </div>
        <p className="mt-4 break-words text-sm font-medium">{albumName}</p>
        <div
          id={descriptionId}
          className="mt-3 space-y-2 text-sm leading-relaxed text-base-content/80"
        >
          <p>{labels.deleteConfirm}</p>
          {shared ? (
            <p className="font-medium text-base-content">{labels.deleteSharedWarning}</p>
          ) : null}
        </div>
        {!online ? (
          <p role="status" className="mt-3 text-sm text-base-content/70">
            {labels.offline}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-error">
            {error}
          </p>
        ) : null}
        <div className="modal-action">
          <button type="button" className="btn" autoFocus disabled={busy} onClick={onClose}>
            {t("topBar.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-error"
            disabled={busy || !online}
            onClick={onConfirm}
          >
            {busy ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : null}
            {busy ? labels.deleting : t("topBar.delete")}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" disabled={busy} onClick={onClose} aria-label={t("topBar.cancel")}>
          {t("topBar.cancel")}
        </button>
      </form>
    </dialog>,
    document.body,
  );
}
