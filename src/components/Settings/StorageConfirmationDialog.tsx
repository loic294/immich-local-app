import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";

interface StorageConfirmationDialogProps {
  title: string;
  description: string;
  warning?: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function StorageConfirmationDialog({
  title,
  description,
  warning,
  busy,
  onConfirm,
  onClose,
}: StorageConfirmationDialogProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
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
      <div className="modal-box">
        <h3 id={titleId} className="break-words text-lg font-semibold">
          {title}
        </h3>
        <div id={descriptionId}>
          <p className="mt-3 text-sm">{description}</p>
          {warning && (
            <p role="alert" className="alert alert-warning mt-4 text-sm">
              {warning}
            </p>
          )}
        </div>
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
        <button type="button" disabled={busy} onClick={onClose}>
          {t("topBar.cancel")}
        </button>
      </form>
    </dialog>,
    document.body,
  );
}
