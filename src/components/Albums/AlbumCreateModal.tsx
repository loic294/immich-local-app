import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { useAlbumManagementLabels } from "../../i18n/albumManagement";

interface AlbumCreateModalProps {
  online: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (albumName: string) => void;
  onClose: () => void;
}

export function AlbumCreateModal({
  online,
  busy,
  error,
  onSubmit,
  onClose,
}: AlbumCreateModalProps) {
  const { t } = useI18n();
  const labels = useAlbumManagementLabels();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState("");
  const [touched, setTouched] = useState(false);
  const trimmedName = draft.trim();
  const isEmpty = trimmedName.length === 0;
  const canCreate = online && !busy && !isEmpty;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    inputRef.current?.focus();
    return () => dialog?.close();
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canCreate) onSubmit(trimmedName);
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      aria-busy={busy}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form className="modal-box max-w-md" onSubmit={handleSubmit}>
        <h3 id={titleId} className="text-lg font-semibold">
          {labels.createTitle}
        </h3>
        <div className="mt-4">
          <label htmlFor={inputId} className="mb-1 block text-sm font-medium">
            {labels.createField}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            className="input w-full"
            value={draft}
            disabled={busy}
            autoComplete="off"
            aria-invalid={touched && isEmpty}
            aria-describedby={hintId}
            onChange={(event) => {
              setTouched(true);
              setDraft(event.target.value);
            }}
          />
        </div>
        <div id={hintId} className="mt-3 space-y-1">
          {touched && isEmpty ? (
            <p role="alert" className="text-sm text-error">
              {labels.renameEmpty}
            </p>
          ) : null}
          {!online ? (
            <p role="status" className="text-sm text-base-content/70">
              {labels.createOffline}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}
        </div>
        <div className="modal-action">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            {t("topBar.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canCreate}>
            {busy ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : null}
            {busy ? labels.creating : labels.createSave}
          </button>
        </div>
      </form>
      <form method="dialog" className="modal-backdrop">
        <button type="button" disabled={busy} onClick={onClose} aria-label={t("topBar.cancel")}>
          {t("topBar.cancel")}
        </button>
      </form>
    </dialog>,
    document.body,
  );
}
