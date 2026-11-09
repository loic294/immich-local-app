import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearActivityLog,
  getActivityLogEntries,
  getActivityLogHistory,
  getActivityLogInfo,
  setActivityLogVerbose,
} from "../api/activityLog";
import type {
  ActivityErrorKind,
  ActivityInfo,
  ActivityLogError,
  ActivityRow,
} from "../types/activityLog";
import {
  HISTORY_LIMIT,
  applyPollResponse,
  isCursorReset,
  nextPollRequest,
  toHistoryRows,
} from "../utils/activityLogBuffer";
import { describeActivityError } from "../utils/activityLogError";
import { createPollLoop, type PollLoop } from "../utils/activityLogPoller";

const LOG_PREFIX = "[activity-log:ui]";
const POLL_INTERVAL_MS = 750;
const MAX_BACKOFF_MS = 10_000;
const INFO_MAX_ATTEMPTS = 3;

export interface UseActivityLogResult {
  /** This launch's entries, oldest first (at most 10,000). */
  entries: readonly ActivityRow[];
  /** Earlier launches, oldest first; empty until "previous sessions" is switched on. */
  historyEntries: readonly ActivityRow[];
  info: ActivityInfo | null;
  verbose: boolean;
  /** Resolves with the verbose state that is actually in effect afterwards; never rejects. */
  setVerbose: (enabled: boolean) => Promise<boolean>;
  /** Wipes the log. Rejects when the backend could not, so the caller can say so. */
  clear: () => Promise<void>;
  historyEnabled: boolean;
  /** Turning it on loads the saved sessions once; turning it off only hides them. */
  setHistoryEnabled: (enabled: boolean) => void;
  historyLoading: boolean;
  error: ActivityLogError | null;
}

/**
 * Live view of the activity log. Polls the local backend (never the network) while the window
 * is visible; polls never overlap and failures back off instead of hammering the backend.
 */
export function useActivityLog(): UseActivityLogResult {
  const [entries, setEntries] = useState<readonly ActivityRow[]>([]);
  const [historyEntries, setHistoryEntries] = useState<readonly ActivityRow[]>([]);
  const [info, setInfo] = useState<ActivityInfo | null>(null);
  const [verbose, setVerboseState] = useState(false);
  const [historyEnabled, setHistoryEnabledState] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<ActivityLogError | null>(null);

  const loopRef = useRef<PollLoop | null>(null);
  const mountedRef = useRef(false);
  const lastIdRef = useRef(0);
  const loadedOnceRef = useRef(false);
  const verboseRef = useRef(false);
  const infoLoadedRef = useRef(false);
  const infoAttemptsRef = useRef(0);
  const historyLoadedRef = useRef(false);
  const historyLoadingRef = useRef(false);
  const historyEpochRef = useRef(0);

  const applyVerbose = useCallback((value: boolean) => {
    verboseRef.current = value;
    setVerboseState(value);
  }, []);

  const clearCommandError = useCallback((kind: ActivityErrorKind) => {
    setCommandError((current) => (current?.kind === kind ? null : current));
  }, []);

  useEffect(() => {
    let disposed = false;
    mountedRef.current = true;

    const loadInfoOnce = async () => {
      if (infoLoadedRef.current || infoAttemptsRef.current >= INFO_MAX_ATTEMPTS) return;
      infoAttemptsRef.current += 1;
      try {
        const next = await getActivityLogInfo();
        if (disposed) return;
        infoLoadedRef.current = true;
        setInfo(next);
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} info unavailable (attempt ${infoAttemptsRef.current}/${INFO_MAX_ATTEMPTS}): ${describeActivityError(error)}`,
        );
      }
    };

    const poll = async () => {
      const request = nextPollRequest(lastIdRef.current);
      const response = await getActivityLogEntries(request);
      if (disposed) return;
      loadedOnceRef.current = true;
      if (isCursorReset(request, response)) {
        console.warn(
          `${LOG_PREFIX} the backend renumbered its entries (cursor ${request.sinceId} -> ${response.lastId}); reloading the list`,
        );
      }
      // Always the backend's cursor: it only ever goes backwards when it numbered from scratch.
      lastIdRef.current = response.lastId;
      setEntries((current) => applyPollResponse(current, response, request));
      applyVerbose(response.verbose);
      await loadInfoOnce();
    };

    const loop = createPollLoop({
      poll,
      // The first load runs even if the window reports itself hidden, so it never opens empty.
      isActive: () => !loadedOnceRef.current || document.visibilityState === "visible",
      intervalMs: POLL_INTERVAL_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      onError: (error, failures) => {
        if (disposed) return;
        const message = describeActivityError(error);
        setPollError(message);
        if (failures === 1) console.error(`${LOG_PREFIX} polling failed: ${message}`);
      },
      onRecovered: () => {
        if (disposed) return;
        setPollError(null);
        console.info(`${LOG_PREFIX} polling recovered`);
      },
    });
    loopRef.current = loop;

    const wake = () => loop.wake();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    loop.start();

    return () => {
      disposed = true;
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      loop.stop();
      if (loopRef.current === loop) loopRef.current = null;
    };
  }, [applyVerbose]);

  const runExclusive = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const loop = loopRef.current;
    return loop ? loop.runExclusive(task) : task();
  }, []);

  const setVerbose = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      try {
        const next = await runExclusive(() => setActivityLogVerbose(enabled));
        if (mountedRef.current) {
          applyVerbose(next);
          clearCommandError("verbose");
        }
        console.info(`${LOG_PREFIX} verbose logging ${next ? "on" : "off"}`);
        return next;
      } catch (error) {
        const message = describeActivityError(error);
        console.error(`${LOG_PREFIX} switching verbose logging failed: ${message}`);
        if (mountedRef.current) setCommandError({ kind: "verbose", message });
        return verboseRef.current;
      }
    },
    [applyVerbose, clearCommandError, runExclusive],
  );

  const clear = useCallback(async (): Promise<void> => {
    console.info(`${LOG_PREFIX} clearing the activity log`);
    try {
      await runExclusive(async () => {
        await clearActivityLog();
        // `lastIdRef` is kept on purpose: ids keep increasing, so later polls only fetch new entries.
        historyEpochRef.current += 1;
        historyLoadedRef.current = true;
        if (!mountedRef.current) return;
        setEntries([]);
        setHistoryEntries([]);
        clearCommandError("history");
      });
      console.info(`${LOG_PREFIX} activity log cleared`);
    } catch (error) {
      console.error(`${LOG_PREFIX} clearing failed: ${describeActivityError(error)}`);
      throw error;
    }
  }, [clearCommandError, runExclusive]);

  const loadHistory = useCallback(() => {
    if (historyLoadedRef.current || historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    const epoch = historyEpochRef.current;
    console.info(`${LOG_PREFIX} loading previous sessions (up to ${HISTORY_LIMIT} entries)`);
    getActivityLogHistory(HISTORY_LIMIT).then(
      (rows) => {
        historyLoadingRef.current = false;
        if (!mountedRef.current) return;
        setHistoryLoading(false);
        // A clear while loading wiped those files, so the result is stale.
        if (epoch !== historyEpochRef.current) return;
        historyLoadedRef.current = true;
        setHistoryEntries(toHistoryRows(rows));
        clearCommandError("history");
        console.info(`${LOG_PREFIX} previous sessions loaded: ${rows.length} entries`);
      },
      (error) => {
        historyLoadingRef.current = false;
        if (!mountedRef.current) return;
        setHistoryLoading(false);
        const message = describeActivityError(error);
        console.error(`${LOG_PREFIX} loading previous sessions failed: ${message}`);
        setCommandError({ kind: "history", message });
      },
    );
  }, [clearCommandError]);

  const setHistoryEnabled = useCallback(
    (enabled: boolean) => {
      setHistoryEnabledState(enabled);
      if (enabled) loadHistory();
    },
    [loadHistory],
  );

  const error = useMemo<ActivityLogError | null>(
    () => (pollError !== null ? { kind: "poll", message: pollError } : commandError),
    [pollError, commandError],
  );

  return {
    entries,
    historyEntries,
    info,
    verbose,
    setVerbose,
    clear,
    historyEnabled,
    setHistoryEnabled,
    historyLoading,
    error,
  };
}
