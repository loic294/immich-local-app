import type { ToastKey } from "../i18n/toasts";
import type { ToastKind, ToastParams } from "./toastStore";

/** A toast described as plain data, so pure helpers can decide what to show and tests can assert it. */
export interface ToastRequest {
  kind: ToastKind;
  key: ToastKey;
  params?: ToastParams;
}
