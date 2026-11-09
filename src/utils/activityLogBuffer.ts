import type { ActivityEntry, ActivityRow } from "../types/activityLog";

/** Matches the Rust ring buffer, so the window never holds more than the app does. */
export const ACTIVITY_BUFFER_CAP = 10_000;
/** The backend maximum. Asking for the most keeps a window that was hidden for a while gap-free. */
export const POLL_LIMIT = 10_000;
export const HISTORY_LIMIT = 5000;

const SESSION_CATEGORY = "session";
const SESSION_START = /^session started\b/i;
const SESSION_END = /^session ended\b/i;

export function isSessionMarker(entry: ActivityEntry): boolean {
  return entry.category === SESSION_CATEGORY;
}

export function isSessionStart(entry: ActivityEntry): boolean {
  return isSessionMarker(entry) && SESSION_START.test(entry.message);
}

export function isSessionEnd(entry: ActivityEntry): boolean {
  return isSessionMarker(entry) && SESSION_END.test(entry.message);
}

export function toCurrentRow(entry: ActivityEntry): ActivityRow {
  return { ...entry, rowKey: `c-${entry.id}`, previousSession: false };
}

/** Ids restart every session, so earlier launches are keyed by position instead. */
export function toHistoryRows(entries: readonly ActivityEntry[]): ActivityRow[] {
  return entries.map((entry, index) => ({ ...entry, rowKey: `h-${index}`, previousSession: true }));
}

export interface AppendOptions {
  /** Entries up to this id were already merged (or deliberately cleared) and are skipped. */
  afterId: number;
  cap?: number;
}

/** Appends new entries, dropping the oldest beyond the cap. Returns `current` itself when nothing is new. */
export function appendEntries(
  current: readonly ActivityRow[],
  incoming: readonly ActivityEntry[],
  { afterId, cap = ACTIVITY_BUFFER_CAP }: AppendOptions,
): readonly ActivityRow[] {
  const fresh = incoming.filter((entry) => entry.id > afterId).map(toCurrentRow);
  if (fresh.length === 0) return current;
  const merged = current.concat(fresh);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export function combineRows(
  history: readonly ActivityRow[],
  current: readonly ActivityRow[],
  includeHistory: boolean,
): readonly ActivityRow[] {
  return includeHistory && history.length > 0 ? history.concat(current) : current;
}

export interface PollRequest {
  sinceId: number;
  limit: number;
}

/** The first poll (`lastId` 0) fetches everything the app holds; later polls only what is new. */
export function nextPollRequest(lastId: number): PollRequest {
  return { sinceId: Math.max(0, lastId), limit: POLL_LIMIT };
}

/** True when the backend treated our cursor as stale and numbered from scratch (ids below the cursor). */
export function isCursorReset(request: PollRequest, response: { lastId: number }): boolean {
  return response.lastId < request.sinceId;
}

/**
 * The list after a poll. Normally the response is appended; after a cursor reset it is the whole
 * truth, so the list is rebuilt from it instead of silently ignoring ids below the old cursor.
 */
export function applyPollResponse(
  current: readonly ActivityRow[],
  response: { entries: readonly ActivityEntry[]; lastId: number },
  request: PollRequest,
): readonly ActivityRow[] {
  if (isCursorReset(request, response)) {
    return appendEntries([], response.entries, { afterId: 0 });
  }
  return appendEntries(current, response.entries, { afterId: request.sinceId });
}

/**
 * Keys of "session started" markers whose previous session never wrote an "ended" marker,
 * i.e. the app crashed or was killed. Computed on the unfiltered rows so filters cannot fake it.
 */
export function findUnexpectedSessionEnds(rows: readonly ActivityRow[]): ReadonlySet<string> {
  const unexpected = new Set<string>();
  let sessionOpen = false;
  for (const row of rows) {
    if (isSessionStart(row)) {
      if (sessionOpen) unexpected.add(row.rowKey);
      sessionOpen = true;
    } else if (isSessionEnd(row)) {
      sessionOpen = false;
    }
  }
  return unexpected;
}
