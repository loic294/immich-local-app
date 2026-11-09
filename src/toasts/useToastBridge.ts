import { useEffect } from "react";
import { ASSET_DELETION_CHANGED_EVENT } from "../api/deletion";
import { ASSETS_TIME_SHIFTED_EVENT } from "../api/time";
import { toastForDeletionChange, toastForTimeShift } from "./bridgeEvents";
import { toast } from "./toast";
import type { ToastRequest } from "./toastRequest";

function bridge(eventName: string, toToast: (detail: unknown) => ToastRequest | null) {
  const listener = (event: Event) => {
    const request = toToast((event as CustomEvent<unknown>).detail);
    if (request) toast.push(request);
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}

/** Turns existing window CustomEvents into toasts. Mount once at the app root. */
export function useToastBridge(): void {
  useEffect(() => {
    const stops = [
      bridge(ASSET_DELETION_CHANGED_EVENT, toastForDeletionChange),
      bridge(ASSETS_TIME_SHIFTED_EVENT, toastForTimeShift),
    ];
    console.info("[toasts] event bridge started", { events: stops.length });
    return () => stops.forEach((stop) => stop());
  }, []);
}
