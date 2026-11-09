// One-line, privacy-first summary of a Tauri command's arguments for the Activity Log.
// Only numbers, booleans, short identifiers and a few enum-like fields are ever shown. Every other
// string is reduced to its length, so paths, names, URLs, queries and credentials never reach the
// log (the log is meant to be pasted into chats).

export const MAX_ARGS_SUMMARY_CHARS = 200;

const MAX_VISIBLE_KEYS = 12;
const MAX_KEY_CHARS = 32;
const MAX_ID_CHARS = 40;
const MAX_ENUM_CHARS = 24;
const SHOWN_IDS_PER_ARRAY = 2;

const SENSITIVE_KEY =
  /token|secret|password|passwd|authorization|cookie|api.?key|credential|session|serverUrl|url|email|path|name|description|query|text/i;
const ID_KEY = /^(?:ids?|.*Ids?)$/;
const ID_VALUE = /^[A-Za-z0-9_:-]+$/;
const ENUM_VALUE = /^[A-Za-z0-9_:-]+$/;
const PLAIN_KEYS = new Set([
  "kind",
  "year",
  "month",
  "page",
  "pageSize",
  "limit",
  "quality",
  "visibility",
  "mode",
  "role",
  "action",
  "sortField",
  "sortDirection",
  "dateKey",
  "event",
  "stage",
]);

const UNREADABLE = "<unreadable>";

function isIdKey(key: string): boolean {
  return ID_KEY.test(key);
}

function isShowableId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ID_CHARS && ID_VALUE.test(value);
}

function isShowableString(key: string, value: string): boolean {
  if (SENSITIVE_KEY.test(key)) return false;
  if (isIdKey(key)) return isShowableId(value);
  return (
    PLAIN_KEYS.has(key) &&
    value.length > 0 &&
    value.length <= MAX_ENUM_CHARS &&
    ENUM_VALUE.test(value)
  );
}

function describeArray(key: string, items: ArrayLike<unknown>): string {
  const count = items.length;
  const noun = count === 1 ? "item" : "items";
  if (count === 0 || !isIdKey(key) || SENSITIVE_KEY.test(key)) return `[${count} ${noun}]`;
  const shown: string[] = [];
  for (let index = 0; index < Math.min(count, SHOWN_IDS_PER_ARRAY); index += 1) {
    const item = items[index];
    if (!isShowableId(item)) return `[${count} ${noun}]`;
    shown.push(item);
  }
  const more = count > shown.length ? ", …" : "";
  return `[${count} ${noun}: ${shown.join(", ")}${more}]`;
}

function describeValue(key: string, value: unknown): string | null {
  switch (typeof value) {
    case "undefined":
      return null;
    case "boolean":
    case "number":
    case "bigint":
      return String(value);
    case "string":
      return isShowableString(key, value) ? `"${value}"` : `"<${value.length} chars>"`;
    case "function":
      return "<function>";
    case "symbol":
      return "<symbol>";
    default:
      if (value === null) return "null";
      if (Array.isArray(value)) return describeArray(key, value);
      return "{…}";
  }
}

function describeKey(key: string): string {
  return key.slice(0, MAX_KEY_CHARS).replace(/[^A-Za-z0-9_$.-]/g, "?");
}

function describeObject(args: object): string {
  const keys = Object.keys(args);
  const parts: string[] = [];
  for (const key of keys.slice(0, MAX_VISIBLE_KEYS)) {
    let description: string | null;
    try {
      description = describeValue(key, (args as Record<string, unknown>)[key]);
    } catch {
      description = UNREADABLE;
    }
    if (description !== null) parts.push(`${describeKey(key)}: ${description}`);
  }
  if (keys.length > MAX_VISIBLE_KEYS) parts.push("…");
  return parts.join(", ");
}

function describeTopLevel(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return `"<${args.length} chars>"`;
  if (Array.isArray(args)) return describeArray("", args);
  if (args instanceof ArrayBuffer) return `<${args.byteLength} bytes>`;
  if (ArrayBuffer.isView(args)) return `<${args.byteLength} bytes>`;
  if (typeof args === "object") return describeObject(args);
  return String(describeValue("", args));
}

/** Never throws: circular objects, throwing getters, BigInt and huge arrays are all handled. */
export function summarizeActivityArgs(args: unknown): string {
  try {
    const text = describeTopLevel(args);
    return text.length > MAX_ARGS_SUMMARY_CHARS
      ? `${text.slice(0, MAX_ARGS_SUMMARY_CHARS - 1)}…`
      : text;
  } catch {
    return UNREADABLE;
  }
}
