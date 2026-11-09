import { useCallback, useEffect, useRef, useState } from "react";
import { describeActivityError } from "../utils/activityLogError";

export interface UseClearLogDialogInput {
  /** Wipes the log; rejects when that failed. */
  clear: () => Promise<void>;
  /** Localised "couldn't clear" sentence for a failure reason. */
  describeFailure: (reason: string) => string;
}

export interface ClearLogDialogState {
  open: boolean;
  busy: boolean;
  error: string | null;
  request: () => void;
  /** Closes the dialog without clearing anything; ignored while a clear is running. */
  cancel: () => void;
  confirm: () => Promise<void>;
}

export function useClearLogDialog({
  clear,
  describeFailure,
}: UseClearLogDialogInput): ClearLogDialogState {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const request = useCallback(() => {
    setError(null);
    setOpen(true);
  }, []);

  const cancel = useCallback(() => {
    if (busyRef.current) return;
    setOpen(false);
    setError(null);
  }, []);

  const confirm = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await clear();
      if (mountedRef.current) setOpen(false);
    } catch (failure) {
      if (mountedRef.current) setError(describeFailure(describeActivityError(failure)));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [clear, describeFailure]);

  return { open, busy, error, request, cancel, confirm };
}
