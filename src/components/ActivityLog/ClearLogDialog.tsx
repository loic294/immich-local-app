import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { TriangleAlert } from "lucide-react";
import { useActivityLogLabels } from "../../i18n/activityLog";

interface ClearLogDialogProps {
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** In-app confirmation before the whole log, saved files included, is deleted. */
export function ClearLogDialog({ busy, error, onConfirm, onClose }: ClearLogDialogProps) {
  const labels = useActivityLogLabels().dialog;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
    };
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
            {labels.title}
          </h3>
        </div>
        <p id={descriptionId} className="mt-3 text-sm leading-relaxed text-base-content/80">
          {labels.body}
        </p>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-error">
            {error}
          </p>
        ) : null}
        <div className="modal-action">
          <button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={onClose}>
            {labels.cancel}
          </button>
          <button type="button" className="btn btn-error" disabled={busy} onClick={onConfirm}>
            {busy ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : null}
            {busy ? labels.confirming : labels.confirm}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" disabled={busy} onClick={onClose} aria-label={labels.cancel}>
          {labels.cancel}
        </button>
      </form>
    </dialog>,
    document.body,
  );
}
