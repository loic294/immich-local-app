import { useRef, type FocusEvent } from "react";
import { CircleCheck, CircleX, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { ToastItem, ToastKind } from "../../toasts/toastStore";

interface ToastCardProps {
  toast: ToastItem;
  message: string;
  dismissLabel: string;
  onDismiss: (id: number) => void;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
}

const KIND_CLASS: Record<ToastKind, string> = {
  success: "alert-success",
  info: "alert-info",
  warning: "alert-warning",
  error: "alert-error",
};

const KIND_ICON: Record<ToastKind, LucideIcon> = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  error: CircleX,
};

export function ToastCard({
  toast,
  message,
  dismissLabel,
  onDismiss,
  onPause,
  onResume,
}: ToastCardProps) {
  const engaged = useRef({ hovered: false, focused: false });
  const Icon = KIND_ICON[toast.kind];

  // The timer stays paused while the pointer is over the card or focus is inside it.
  const setEngaged = (patch: Partial<typeof engaged.current>) => {
    const wasEngaged = engaged.current.hovered || engaged.current.focused;
    engaged.current = { ...engaged.current, ...patch };
    const isEngaged = engaged.current.hovered || engaged.current.focused;
    if (isEngaged && !wasEngaged) onPause(toast.id);
    if (!isEngaged && wasEngaged) onResume(toast.id);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setEngaged({ focused: false });
  };

  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      className={`alert ${KIND_CLASS[toast.kind]} pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] animate-toast-in items-start gap-2 py-2 shadow-lg motion-reduce:animate-none`}
      onMouseEnter={() => setEngaged({ hovered: true })}
      onMouseLeave={() => setEngaged({ hovered: false })}
      onFocus={() => setEngaged({ focused: true })}
      onBlur={handleBlur}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <span className="min-w-0 flex-1 text-sm break-words">{message}</span>
      <button
        type="button"
        className="btn btn-circle btn-ghost btn-xs shrink-0"
        aria-label={dismissLabel}
        onClick={() => onDismiss(toast.id)}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
