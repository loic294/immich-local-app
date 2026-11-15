import type { ReactNode } from "react";

type Props = {
  title: string;
  zIndexClass: string;
  stopPropagation?: boolean;
  working: boolean;
  error: string | null;
  labels: { confirm: string; cancel: string; working: string };
  danger?: boolean;
  canConfirm: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
};

/** Confirmation modal shared by the ISM file and folder actions. */
export function IsmDialog({
  title,
  zIndexClass,
  stopPropagation = false,
  working,
  error,
  labels,
  danger = false,
  canConfirm,
  onCancel,
  onConfirm,
  children,
}: Props) {
  return (
    <div
      data-shortcut-modal=""
      className={`fixed inset-0 ${zIndexClass} flex items-center justify-center bg-black/45 p-4`}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (stopPropagation) event.stopPropagation();
        if (event.key === "Escape") onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded-box border border-base-300 bg-base-100 p-5 text-base-content shadow-xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (canConfirm && !working) onConfirm();
        }}
      >
        <h3 className="m-0 mb-3 text-lg font-semibold">{title}</h3>
        {children}
        {error ? (
          <div role="alert" className="alert alert-error mt-3 py-2 text-sm">
            <span className="break-words">{error}</span>
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" disabled={working} onClick={onCancel}>
            {labels.cancel}
          </button>
          <button
            type="submit"
            className={`btn ${danger ? "btn-error" : "btn-primary"}`}
            disabled={working || !canConfirm}
          >
            {working ? labels.working : labels.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
