import type { ActivityEntry, ActivityFilters, ActivityInfo } from "../types/activityLog";
import { isSessionMarker } from "./activityLogBuffer";
import { describeFilters } from "./activityLogFilter";

export const COPY_MAX_ENTRIES = 1500;

const LEVEL_WIDTH = 5;
const SOURCE_CATEGORY_WIDTH = 15;
const CONTINUATION_INDENT = "    ";
const LINE_BREAK = /\r\n|\r|\n/;
const MINUS_SIGN = "\u2212";

export interface ClockParts {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  millis: number;
}

/** Everything that depends on the machine's time zone, so tests can pin it. */
export interface LocalClock {
  parts: (timestampMs: number) => ClockParts;
  utcOffsetMinutes: (timestampMs: number) => number;
}

export const systemClock: LocalClock = {
  parts(timestampMs) {
    const date = new Date(timestampMs);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hours: date.getHours(),
      minutes: date.getMinutes(),
      seconds: date.getSeconds(),
      millis: date.getMilliseconds(),
    };
  },
  utcOffsetMinutes(timestampMs) {
    return 0 - new Date(timestampMs).getTimezoneOffset();
  },
};

export function fixedOffsetClock(offsetMinutes: number): LocalClock {
  return {
    parts(timestampMs) {
      const shifted = new Date(timestampMs + offsetMinutes * 60_000);
      return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hours: shifted.getUTCHours(),
        minutes: shifted.getUTCMinutes(),
        seconds: shifted.getUTCSeconds(),
        millis: shifted.getUTCMilliseconds(),
      };
    },
    utcOffsetMinutes: () => offsetMinutes,
  };
}

const pad2 = (value: number) => String(value).padStart(2, "0");

export function formatClockDate(parts: ClockParts): string {
  return `${String(parts.year).padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function formatClockSeconds(parts: ClockParts): string {
  return `${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)}`;
}

export function formatEntryTime(timestampMs: number, clock: LocalClock = systemClock): string {
  const parts = clock.parts(timestampMs);
  return `${formatClockSeconds(parts)}.${String(parts.millis).padStart(3, "0")}`;
}

export function formatDateKey(timestampMs: number, clock: LocalClock = systemClock): string {
  return formatClockDate(clock.parts(timestampMs));
}

/** `UTC−04:00`, `UTC+05:30`, `UTC+00:00`; the sign is a real minus (U+2212) like the copy header. */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? MINUS_SIGN : "+";
  const total = Math.round(Math.abs(offsetMinutes));
  return `UTC${sign}${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** Thousands separated with commas, independent of the UI language, so pasted logs read the same. */
export function formatCount(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms} ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)} min ${totalSeconds % 60} s`;
}

const dateLabelFormats = new Map<string, Intl.DateTimeFormat>();

/** Long, localised date for the on-screen dividers. */
export function formatDateLabel(timestampMs: number, locale: string): string {
  let format = dateLabelFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    dateLabelFormats.set(locale, format);
  }
  return format.format(new Date(timestampMs));
}

/** One entry as copy text: a header line, plus one indented line per extra message line. */
export function formatEntryLine(entry: ActivityEntry, clock: LocalClock = systemClock): string {
  const [firstLine = "", ...continuation] = entry.message.trimEnd().split(LINE_BREAK);
  const head = [
    formatEntryTime(entry.timestampMs, clock),
    entry.level.toUpperCase().padEnd(LEVEL_WIDTH),
    `${entry.source}/${entry.category}`.padEnd(SOURCE_CATEGORY_WIDTH),
    firstLine,
  ]
    .join(" ")
    .trimEnd();
  return [
    entry.slow ? `${head} [slow]` : head,
    ...continuation.map((line) => (line === "" ? "" : `${CONTINUATION_INDENT}${line}`)),
  ].join("\n");
}

export function formatSessionDivider(entry: ActivityEntry): string {
  const text = entry.message
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  return `--- ${text} ---`;
}

export interface CopyTextInput {
  /** The filtered view, oldest first. */
  entries: readonly ActivityEntry[];
  info: ActivityInfo | null;
  filters: ActivityFilters;
  /** Every entry the window currently holds, before filtering. */
  totalCount: number;
  now: Date;
  maxLines?: number;
  clock?: LocalClock;
}

export function exportedEntryCount(entryCount: number, maxLines = COPY_MAX_ENTRIES): number {
  return Math.min(entryCount, Math.max(0, Math.floor(maxLines)));
}

export function formatCopyText({
  entries,
  info,
  filters,
  totalCount,
  now,
  maxLines = COPY_MAX_ENTRIES,
  clock = systemClock,
}: CopyTextInput): string {
  const limit = Math.max(0, Math.floor(maxLines));
  const kept = entries.slice(entries.length - exportedEntryCount(entries.length, limit));
  const exportedAtMs = now.getTime();
  const exportedAt = clock.parts(exportedAtMs);
  const exportDate = formatClockDate(exportedAt);
  const app = info ? `${info.appVersion} · ${info.os} ${info.arch}` : "unknown";
  const offset = formatUtcOffset(clock.utcOffsetMinutes(exportedAtMs));

  const lines = [
    "# Immich Local — Activity Log",
    `# App ${app} · exported ${exportDate} ${formatClockSeconds(exportedAt)} (${offset})`,
    `# Filters: ${describeFilters(filters)}`,
    `# Entries: ${formatCount(entries.length)} of ${formatCount(totalCount)} (newest ${formatCount(limit)} max)`,
  ];

  // Dates are relative to the export day, so entries from earlier days are always announced.
  let currentDate = exportDate;
  for (const entry of kept) {
    const date = formatDateKey(entry.timestampMs, clock);
    if (date !== currentDate) {
      lines.push(`--- date ${date} ---`);
      currentDate = date;
    }
    lines.push(
      isSessionMarker(entry) ? formatSessionDivider(entry) : formatEntryLine(entry, clock),
    );
  }
  return lines.join("\n");
}
