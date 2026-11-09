import { useSyncExternalStore } from "react";
import { getToastSnapshot, subscribeToToasts, type ToastItem } from "./toastStore";

export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(subscribeToToasts, getToastSnapshot, getToastSnapshot);
}
