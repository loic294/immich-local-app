import { useCallback, useMemo, useRef } from "react";
import { toast } from "../toasts/toast";

export interface MediaErrorToasts {
  report: (source: string, message: string) => void;
  clear: (source: string) => void;
}

/**
 * Polling loops (upload flush, device scan) can fail with the same error on every tick.
 * Report an error once per source until its message changes or the source recovers.
 */
export function useMediaErrorToast(): MediaErrorToasts {
  const reported = useRef(new Map<string, string>());

  const report = useCallback((source: string, message: string) => {
    if (reported.current.get(source) === message) return;
    reported.current.set(source, message);
    toast.error("media.error", { message });
  }, []);

  const clear = useCallback((source: string) => {
    reported.current.delete(source);
  }, []);

  return useMemo(() => ({ report, clear }), [report, clear]);
}
