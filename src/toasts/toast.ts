import type { ToastKey } from "../i18n/toasts";
import type { ToastRequest } from "./toastRequest";
import { dismissToast, pushToast, type ToastKind, type ToastParams } from "./toastStore";

export type { ToastRequest } from "./toastRequest";
export type { ToastKind, ToastParams } from "./toastStore";

function show(kind: ToastKind, key: ToastKey, params?: ToastParams): number | null {
  console.info("[toasts] push", { kind, key, count: params?.count ?? 1 });
  return pushToast(kind, key, params);
}

// Callable from hooks, API modules and event handlers: no React required.
export const toast = {
  success: (key: ToastKey, params?: ToastParams) => show("success", key, params),
  info: (key: ToastKey, params?: ToastParams) => show("info", key, params),
  warning: (key: ToastKey, params?: ToastParams) => show("warning", key, params),
  error: (key: ToastKey, params?: ToastParams) => show("error", key, params),
  push: (request: ToastRequest) => show(request.kind, request.key, request.params),
  dismiss: (id: number) => dismissToast(id),
};
