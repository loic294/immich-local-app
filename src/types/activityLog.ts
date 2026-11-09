export type ActivityLevel = "debug" | "info" | "warn" | "error";
export type ActivitySource = "rust" | "frontend";

export interface ActivityEntry {
  /** Monotonic per app session; restarts at 1 on every launch. */
  id: number;
  timestampMs: number;
  level: ActivityLevel;
  category: string;
  source: ActivitySource;
  message: string;
  durationMs?: number;
  slow: boolean;
}

export interface ActivityEntriesRequest {
  sinceId: number;
  limit?: number;
}

export interface ActivityEntriesResponse {
  entries: ActivityEntry[];
  lastId: number;
  verbose: boolean;
}

export interface ActivityInfo {
  appVersion: string;
  os: string;
  arch: string;
  logDir: string;
  sessionStartedMs: number;
  pid: number;
  verbose: boolean;
}

export type ActivityTimeRange = "all" | "1m" | "5m" | "15m" | "60m";

export interface ActivityFilters {
  levels: ReadonlySet<ActivityLevel>;
  /** Exact category, or "all". */
  category: string;
  search: string;
  slowOnly: boolean;
  range: ActivityTimeRange;
}

export type LevelCounts = Record<ActivityLevel, number>;

/** An entry plus the identity the list needs: ids restart each session, so rows are keyed separately. */
export interface ActivityRow extends ActivityEntry {
  rowKey: string;
  previousSession: boolean;
}

export type ActivityListItem =
  | { kind: "entry"; key: string; row: ActivityRow }
  | { kind: "session"; key: string; row: ActivityRow; unexpectedEnd: boolean }
  | { kind: "date"; key: string; timestampMs: number };

export type ActivityErrorKind = "poll" | "history" | "verbose";

export interface ActivityLogError {
  kind: ActivityErrorKind;
  message: string;
}
