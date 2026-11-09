import type {
  ActivityEntry,
  ActivityFilters,
  ActivityLevel,
  ActivityTimeRange,
  LevelCounts,
} from "../types/activityLog";

/** Severity order, used for chips and for the copy header. */
export const ACTIVITY_LEVELS: readonly ActivityLevel[] = ["error", "warn", "info", "debug"];

export const ALL_CATEGORIES = "all";

export const TIME_RANGES: readonly ActivityTimeRange[] = ["all", "1m", "5m", "15m", "60m"];

const RANGE_MS: Record<Exclude<ActivityTimeRange, "all">, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "60m": 60 * 60_000,
};

/** How each range is spelled in the copy header. */
const RANGE_COPY_LABEL: Record<ActivityTimeRange, string> = {
  all: "all",
  "1m": "1 min",
  "5m": "5 min",
  "15m": "15 min",
  "60m": "60 min",
};

export const DEFAULT_FILTERS: ActivityFilters = {
  levels: new Set<ActivityLevel>(["error", "warn", "info"]),
  category: ALL_CATEGORIES,
  search: "",
  slowOnly: false,
  range: "all",
};

const ALL_LEVELS: ReadonlySet<ActivityLevel> = new Set(ACTIVITY_LEVELS);

export function isActivityTimeRange(value: string): value is ActivityTimeRange {
  return (TIME_RANGES as readonly string[]).includes(value);
}

function toMillis(now: number | Date): number {
  return typeof now === "number" ? now : now.getTime();
}

function matchesSearch(entry: ActivityEntry, needle: string): boolean {
  return `${entry.source}/${entry.category} ${entry.message}`.toLowerCase().includes(needle);
}

/** Keeps the original order; returns rows of the same type so callers keep their extra fields. */
export function filterEntries<T extends ActivityEntry>(
  entries: readonly T[],
  filters: ActivityFilters,
  now: number | Date,
): T[] {
  const cutoff = filters.range === "all" ? null : toMillis(now) - RANGE_MS[filters.range];
  const needle = filters.search.trim().toLowerCase();
  const anyCategory = filters.category === ALL_CATEGORIES;

  return entries.filter((entry) => {
    if (!filters.levels.has(entry.level)) return false;
    if (!anyCategory && entry.category !== filters.category) return false;
    if (filters.slowOnly && !entry.slow) return false;
    if (cutoff !== null && entry.timestampMs < cutoff) return false;
    return needle === "" || matchesSearch(entry, needle);
  });
}

/** Level counts for every filter except the level one, so hidden levels still show how many they hold. */
export function countLevelsIgnoringLevelFilter<T extends ActivityEntry>(
  entries: readonly T[],
  filters: ActivityFilters,
  now: number | Date,
): LevelCounts {
  return countByLevel(filterEntries(entries, { ...filters, levels: ALL_LEVELS }, now));
}

export function countByLevel(entries: readonly ActivityEntry[]): LevelCounts {
  const counts: LevelCounts = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const entry of entries) counts[entry.level] += 1;
  return counts;
}

/** Sorted unique categories; `keep` stays listed so a selection never disappears from its own menu. */
export function listCategories(entries: readonly ActivityEntry[], keep?: string): string[] {
  const found = new Set<string>();
  for (const entry of entries) found.add(entry.category);
  if (keep && keep !== ALL_CATEGORIES) found.add(keep);
  return Array.from(found).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function describeFilters(filters: ActivityFilters): string {
  const levels = ACTIVITY_LEVELS.filter((level) => filters.levels.has(level));
  return [
    `levels=${levels.length > 0 ? levels.join(",") : "none"}`,
    `category=${filters.category}`,
    `slow-only=${filters.slowOnly ? "on" : "off"}`,
    `range=${RANGE_COPY_LABEL[filters.range]}`,
    `search=${JSON.stringify(filters.search.trim())}`,
  ].join(" · ");
}

export function setLevelEnabled(
  filters: ActivityFilters,
  level: ActivityLevel,
  enabled: boolean,
): ActivityFilters {
  if (filters.levels.has(level) === enabled) return filters;
  const levels = new Set(filters.levels);
  if (enabled) levels.add(level);
  else levels.delete(level);
  return { ...filters, levels };
}

export function toggleLevel(filters: ActivityFilters, level: ActivityLevel): ActivityFilters {
  return setLevelEnabled(filters, level, !filters.levels.has(level));
}

export function areFiltersDefault(filters: ActivityFilters): boolean {
  return (
    filters.category === DEFAULT_FILTERS.category &&
    filters.search.trim() === DEFAULT_FILTERS.search &&
    filters.slowOnly === DEFAULT_FILTERS.slowOnly &&
    filters.range === DEFAULT_FILTERS.range &&
    ACTIVITY_LEVELS.every(
      (level) => filters.levels.has(level) === DEFAULT_FILTERS.levels.has(level),
    )
  );
}
