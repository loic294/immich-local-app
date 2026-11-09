import type { ActivityListItem, ActivityRow } from "../types/activityLog";
import { isSessionMarker } from "./activityLogBuffer";
import { systemClock, type LocalClock } from "./activityLogFormat";

/**
 * Turns the visible rows into what the list renders: a date divider whenever the local day
 * changes (and before the first row), session markers as dividers, everything else as entries.
 */
export function buildListItems(
  rows: readonly ActivityRow[],
  unexpectedEnds: ReadonlySet<string>,
  clock: LocalClock = systemClock,
): ActivityListItem[] {
  const items: ActivityListItem[] = [];
  let currentDay = -1;
  for (const row of rows) {
    const { year, month, day } = clock.parts(row.timestampMs);
    const dayNumber = year * 10_000 + month * 100 + day;
    if (dayNumber !== currentDay) {
      items.push({ kind: "date", key: `date-${row.rowKey}`, timestampMs: row.timestampMs });
      currentDay = dayNumber;
    }
    items.push(
      isSessionMarker(row)
        ? { kind: "session", key: row.rowKey, row, unexpectedEnd: unexpectedEnds.has(row.rowKey) }
        : { kind: "entry", key: row.rowKey, row },
    );
  }
  return items;
}

const ENTRY_LINE_PX = 18;
const ENTRY_PADDING_PX = 8;
const DIVIDER_PX = 32;
const SESSION_PADDING_PX = 8;
const UNEXPECTED_END_NOTE_PX = 20;

function countLines(text: string): number {
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return lines;
}

/** Rough height guess for a not-yet-measured item; the list refines it once the row is rendered. */
export function estimateItemHeight(item: ActivityListItem | undefined): number {
  if (item === undefined || item.kind === "date") return DIVIDER_PX;
  if (item.kind === "session") {
    return DIVIDER_PX + SESSION_PADDING_PX + (item.unexpectedEnd ? UNEXPECTED_END_NOTE_PX : 0);
  }
  return countLines(item.row.message) * ENTRY_LINE_PX + ENTRY_PADDING_PX;
}

/** Entries that arrived after the item with `key`; null when that item is no longer listed. */
export function countEntriesAfter(items: readonly ActivityListItem[], key: string): number | null {
  let count = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.key === key) return count;
    if (item.kind !== "date") count += 1;
  }
  return null;
}
