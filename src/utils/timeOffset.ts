import type { TimeOffsetParts } from "../types/time";

export function splitOffset(totalSeconds: number): TimeOffsetParts {
  const sign: 1 | -1 = totalSeconds < 0 ? -1 : 1;
  let remaining = Math.abs(Math.trunc(totalSeconds));
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  return { sign, days, hours, minutes, seconds: remaining - minutes * 60 };
}

export function joinOffset(parts: TimeOffsetParts): number {
  const clean = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
  return (
    parts.sign *
    (clean(parts.days) * 86400 +
      clean(parts.hours) * 3600 +
      clean(parts.minutes) * 60 +
      clean(parts.seconds))
  );
}

/** Seconds between two ISO timestamps (`to - from`), or null if either is invalid. */
export function differenceSeconds(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 1000);
}

export function formatAssetDateTime(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function shiftIso(value: string | null, offsetSeconds: number): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time + offsetSeconds * 1000).toISOString();
}
