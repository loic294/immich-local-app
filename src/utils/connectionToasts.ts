import type { ToastRequest } from "../toasts/toastRequest";

/**
 * Toast for a connectivity change. The first probe (previous state unknown) and unchanged states
 * stay silent. Coming back online folds the number of replayed offline changes into the same toast.
 */
export function connectionChangeToast(
  wasOnline: boolean | null,
  online: boolean,
  flushedChanges = 0,
): ToastRequest | null {
  if (wasOnline === null || wasOnline === online) return null;
  if (!online) return { kind: "warning", key: "connection.lost" };
  return flushedChanges > 0
    ? { kind: "success", key: "connection.queuedFlushed", params: { count: flushedChanges } }
    : { kind: "success", key: "connection.restored" };
}
