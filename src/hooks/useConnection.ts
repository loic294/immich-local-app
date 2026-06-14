import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkServerConnection,
  flushPendingMutations,
  getPendingMutationCount,
} from "../api/tauri";

const POLL_INTERVAL_MS = 20_000;

export type UseConnectionOptions = {
  /** Whether connection monitoring is active (typically: a session exists). */
  enabled: boolean;
  /** Seed the initial online state from session restore (offline => false). */
  initialOnline?: boolean;
  /** Invoked after the server becomes reachable again (post queue-flush). */
  onReconnect?: () => void;
};

export type UseConnectionReturn = {
  /** Null until the first probe completes. */
  isOnline: boolean | null;
  /** Mutations queued locally while offline, awaiting replay. */
  pendingCount: number;
  /** Force an immediate connectivity probe (e.g. on manual sync). */
  recheck: () => Promise<boolean>;
};

/**
 * Local-first connection monitor. Probes the Immich server on an interval,
 * exposes the online/offline state, and replays queued offline mutations when
 * connectivity is restored. Logs transitions for diagnostics.
 */
export function useConnection({
  enabled,
  initialOnline,
  onReconnect,
}: UseConnectionOptions): UseConnectionReturn {
  const [isOnline, setIsOnline] = useState<boolean | null>(
    initialOnline ?? null,
  );
  const [pendingCount, setPendingCount] = useState(0);
  const wasOnlineRef = useRef<boolean | null>(initialOnline ?? null);
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  const refreshPendingCount = useCallback(async () => {
    try {
      setPendingCount(await getPendingMutationCount());
    } catch (err) {
      console.warn("[connection] failed to read pending mutation count", err);
    }
  }, []);

  const recheck = useCallback(async (): Promise<boolean> => {
    let online = false;
    try {
      online = await checkServerConnection();
    } catch (err) {
      console.warn("[connection] connectivity probe failed", err);
      online = false;
    }

    setIsOnline(online);

    const wasOnline = wasOnlineRef.current;
    wasOnlineRef.current = online;

    if (online && wasOnline === false) {
      // Transitioned offline -> online: replay queued mutations, then notify.
      console.info("[connection] server reachable again — flushing queue");
      try {
        const remaining = await flushPendingMutations();
        setPendingCount(remaining);
      } catch (err) {
        console.warn("[connection] failed to flush pending mutations", err);
      }
      onReconnectRef.current?.();
    } else {
      void refreshPendingCount();
    }

    if (!online && wasOnline !== false) {
      console.warn("[connection] server unreachable — entering offline mode");
    }

    return online;
  }, [refreshPendingCount]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void recheck();
    const interval = window.setInterval(() => {
      void recheck();
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [enabled, recheck]);

  return { isOnline, pendingCount, recheck };
}
