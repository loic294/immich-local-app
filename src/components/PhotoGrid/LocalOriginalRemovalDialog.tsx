import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "../../i18n";

interface LocalOriginalRemovalDialogProps {
  fileName: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function LocalOriginalRemovalDialog({
  fileName,
  busy,
  onConfirm,
  onClose,
}: LocalOriginalRemovalDialogProps) {
  const { t } = useI18n();
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
          <TriangleAlert className="mt-1 shrink-0 text-warning" size={24} aria-hidden="true" />
          <h3 id={titleId} className="text-lg font-semibold">
            {t("photoGrid.removeLocalOriginal")}
          </h3>
        </div>
        <p className="mt-4 break-all text-sm font-medium">{fileName}</p>
        <p id={descriptionId} className="mt-3 text-sm leading-relaxed text-base-content/80">
          {t("photoGrid.removeLocalOriginalConfirm")}
        </p>
        <div className="modal-action">
          <button type="button" className="btn" autoFocus disabled={busy} onClick={onClose}>
            {t("topBar.cancel")}
          </button>
          <button type="button" className="btn btn-error" disabled={busy} onClick={onConfirm}>
            {busy && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            {t("topBar.delete")}
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
