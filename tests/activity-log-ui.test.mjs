import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// React reports each problem once per component, so a warning raised by any test must still fail
// the file even when a later render of the same component stays silent.
const reactWarnings = [];
const consoleError = console.error;
console.error = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("Warning:")) reactWarnings.push(args[0]);
  consoleError.apply(console, args);
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const nodeRequire = createRequire(import.meta.url);

function resolveSource(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found, `cannot resolve ${specifier} from ${fromFile}`);
  return found;
}

const moduleKey = (file) =>
  relative(repoRoot, file)
    .replace(/\\/g, "/")
    .replace(/\.tsx?$/, "");

/**
 * Transpiles and runs a repo module. Relative imports are loaded from source too, unless `doubles`
 * has an entry for the package name or for the repo path without extension (`src/i18n/index`).
 */
function loadModule(path, doubles = {}) {
  const cache = new Map();
  const loadFile = (file) => {
    const key = moduleKey(file);
    if (key in doubles) return doubles[key];
    if (cache.has(key)) return cache.get(key).exports;
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      // Without the real name `.ts` sources are parsed as TSX, which breaks generic arrows.
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    const module = { exports: {} };
    cache.set(key, module);
    const require = (name) => {
      if (name in doubles) return doubles[name];
      if (name.startsWith(".")) return loadFile(resolveSource(file, name));
      return nodeRequire(name);
    };
    new Function("require", "module", "exports", outputText)(require, module, module.exports);
    return module.exports;
  };
  return loadFile(resolve(repoRoot, path));
}

const MINUTE = 60_000;
// 2026-05-17 14:03:22 on a clock that is UTC−04:00.
const NOW = Date.UTC(2026, 4, 17, 18, 3, 22);
const local = (day, hours, minutes, seconds, millis = 0) =>
  Date.UTC(2026, 4, day, hours + 4, minutes, seconds, millis);

let idCounter = 1000;
function entry(overrides = {}) {
  idCounter += 1;
  return {
    id: idCounter,
    timestampMs: NOW,
    level: "info",
    category: "sync",
    source: "rust",
    message: `message ${idCounter}`,
    slow: false,
    ...overrides,
  };
}

const info = {
  appVersion: "1.2.3",
  os: "macOS",
  arch: "aarch64",
  logDir: "/Users/someone/Library/Logs/immich-local",
  sessionStartedMs: NOW - 60 * MINUTE,
  pid: 4242,
  verbose: false,
};

const format = loadModule("src/utils/activityLogFormat.ts");
const filter = loadModule("src/utils/activityLogFilter.ts");
const buffer = loadModule("src/utils/activityLogBuffer.ts");
const listItems = loadModule("src/utils/activityLogItems.ts");
const scroll = loadModule("src/utils/activityLogScroll.ts");
const poller = loadModule("src/utils/activityLogPoller.ts");
const { describeActivityError } = loadModule("src/utils/activityLogError.ts");

const clock = format.fixedOffsetClock(-240);
const { DEFAULT_FILTERS } = filter;
const filtersWith = (changes) => ({ ...DEFAULT_FILTERS, ...changes });
const ids = (rows) => rows.map((row) => row.id);

// ---------------------------------------------------------------------------------------------
// Formatting

test("UTC offsets use a real minus sign and +00:00 for UTC", () => {
  assert.equal(format.formatUtcOffset(-240), "UTC\u221204:00");
  assert.equal(format.formatUtcOffset(-570), "UTC\u221209:30");
  assert.equal(format.formatUtcOffset(330), "UTC+05:30");
  assert.equal(format.formatUtcOffset(60), "UTC+01:00");
  assert.equal(format.formatUtcOffset(0), "UTC+00:00");
  assert.ok(!format.formatUtcOffset(-240).includes("-"), "never an ASCII hyphen");
});

test("a fixed-offset clock gives wall-clock parts independent of the machine time zone", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(clock.parts(local(17, 14, 2, 11, 482)))), {
    year: 2026,
    month: 5,
    day: 17,
    hours: 14,
    minutes: 2,
    seconds: 11,
    millis: 482,
  });
  assert.equal(clock.utcOffsetMinutes(NOW), -240);
  assert.equal(format.formatEntryTime(local(17, 9, 5, 3, 7), clock), "09:05:03.007");
  assert.equal(format.formatDateKey(local(16, 23, 59, 58, 900), clock), "2026-05-16");
  assert.equal(format.formatDateKey(local(17, 0, 0, 0), clock), "2026-05-17");
});

test("durations read as ms, seconds or minutes without rounding up into the next unit", () => {
  assert.equal(format.formatDuration(0), "0 ms");
  assert.equal(format.formatDuration(312), "312 ms");
  assert.equal(format.formatDuration(999.6), "1.0 s");
  assert.equal(format.formatDuration(1200), "1.2 s");
  assert.equal(format.formatDuration(1480), "1.5 s");
  assert.equal(format.formatDuration(59_999), "1 min 0 s");
  assert.equal(format.formatDuration(125_000), "2 min 5 s");
  assert.equal(format.formatDuration(-5), "0 ms");
});

test("counts use comma thousands separators whatever the UI language", () => {
  assert.equal(format.formatCount(0), "0");
  assert.equal(format.formatCount(999), "999");
  assert.equal(format.formatCount(1500), "1,500");
  assert.equal(format.formatCount(3017), "3,017");
  assert.equal(format.formatCount(1_234_567), "1,234,567");
});

test("an entry line is time, padded level, padded source/category, then the message", () => {
  const short = entry({
    timestampMs: local(17, 14, 2, 11, 482),
    level: "info",
    source: "rust",
    category: "sync",
    message: "check_for_new_assets done in 1.2s",
  });
  assert.equal(
    format.formatEntryLine(short, clock),
    "14:02:11.482 INFO  rust/sync       check_for_new_assets done in 1.2s",
  );
  const long = entry({
    timestampMs: local(17, 9, 5, 3, 7),
    level: "error",
    source: "frontend",
    category: "console",
    message: "boom",
  });
  assert.equal(format.formatEntryLine(long, clock), "09:05:03.007 ERROR frontend/console boom");
});

test("[slow] ends the first line only and further lines are indented by four spaces", () => {
  const multiline = entry({
    timestampMs: local(17, 14, 3, 0, 9),
    slow: true,
    message: "line one\nline two\r\n  indented\n\nlast",
  });
  assert.equal(
    format.formatEntryLine(multiline, clock),
    [
      "14:03:00.009 INFO  rust/sync       line one [slow]",
      "    line two",
      "      indented",
      "",
      "    last",
    ].join("\n"),
  );
});

test("trailing blank lines are dropped and durationMs is never appended to the text", () => {
  const trailing = entry({
    timestampMs: local(17, 14, 2, 11, 640),
    level: "warn",
    category: "http",
    message: "GET /api/timeline/buckets → 200 in 1,480ms\n\n",
    durationMs: 1480,
    slow: true,
  });
  assert.equal(
    format.formatEntryLine(trailing, clock),
    "14:02:11.640 WARN  rust/http       GET /api/timeline/buckets → 200 in 1,480ms [slow]",
  );
  const empty = entry({ timestampMs: local(17, 14, 2, 11, 640), message: "" });
  assert.equal(format.formatEntryLine(empty, clock), "14:02:11.640 INFO  rust/sync");
});

test("session markers become one-line dividers", () => {
  const marker = entry({ category: "session", message: "session ended (clean exit)" });
  assert.equal(format.formatSessionDivider(marker), "--- session ended (clean exit) ---");
  assert.equal(
    format.formatSessionDivider(entry({ category: "session", message: " first \n\n second " })),
    "--- first second ---",
  );
});

function sampleCopyEntries() {
  return [
    entry({
      timestampMs: local(16, 23, 59, 58, 900),
      message: "last sync of the evening",
    }),
    entry({
      timestampMs: local(17, 14, 0, 0, 5),
      category: "session",
      message: "session started · app v1.2.3 · macOS aarch64 · pid 4242",
    }),
    entry({
      timestampMs: local(17, 14, 2, 11, 482),
      message: "check_for_new_assets done in 1.2s",
      slow: true,
    }),
    entry({
      timestampMs: local(17, 14, 2, 11, 640),
      level: "warn",
      category: "http",
      message: "GET /api/timeline/buckets → 200 in 1,480ms",
      slow: true,
    }),
    entry({
      timestampMs: local(17, 14, 2, 12, 4),
      level: "error",
      source: "frontend",
      category: "invoke",
      message: "create_album_with_assets failed after 312ms: offline: server unreachable",
    }),
    entry({
      timestampMs: local(17, 14, 2, 30, 0),
      level: "warn",
      source: "frontend",
      category: "console",
      message: "Unhandled promise rejection\nTypeError: x is undefined\n  at fetch (main.js:1)",
    }),
    entry({
      timestampMs: local(17, 14, 3, 0, 9),
      slow: true,
      message: "line one\nline two",
    }),
  ];
}

test("the copy text matches the contract format exactly", () => {
  const text = format.formatCopyText({
    entries: sampleCopyEntries(),
    info,
    filters: DEFAULT_FILTERS,
    totalCount: 3017,
    now: new Date(NOW),
    clock,
  });
  assert.equal(
    text,
    [
      "# Immich Local — Activity Log",
      "# App 1.2.3 · macOS aarch64 · exported 2026-05-17 14:03:22 (UTC\u221204:00)",
      '# Filters: levels=error,warn,info · category=all · slow-only=off · range=all · search=""',
      "# Entries: 7 of 3,017 (newest 1,500 max)",
      "--- date 2026-05-16 ---",
      "23:59:58.900 INFO  rust/sync       last sync of the evening",
      "--- date 2026-05-17 ---",
      "--- session started · app v1.2.3 · macOS aarch64 · pid 4242 ---",
      "14:02:11.482 INFO  rust/sync       check_for_new_assets done in 1.2s [slow]",
      "14:02:11.640 WARN  rust/http       GET /api/timeline/buckets → 200 in 1,480ms [slow]",
      "14:02:12.004 ERROR frontend/invoke create_album_with_assets failed after 312ms: offline: server unreachable",
      "14:02:30.000 WARN  frontend/console Unhandled promise rejection",
      "    TypeError: x is undefined",
      "      at fetch (main.js:1)",
      "14:03:00.009 INFO  rust/sync       line one [slow]",
      "    line two",
    ].join("\n"),
  );
});

test("the copy header describes the filters like the contract example", () => {
  const text = format.formatCopyText({
    entries: [],
    info,
    filters: filtersWith({ range: "15m" }),
    totalCount: 412,
    now: new Date(NOW),
    clock,
  });
  assert.equal(
    text,
    [
      "# Immich Local — Activity Log",
      "# App 1.2.3 · macOS aarch64 · exported 2026-05-17 14:03:22 (UTC\u221204:00)",
      '# Filters: levels=error,warn,info · category=all · slow-only=off · range=15 min · search=""',
      "# Entries: 0 of 412 (newest 1,500 max)",
    ].join("\n"),
  );
});

test("the copy header records the exporting time zone and tolerates missing app info", () => {
  const header = (offsetMinutes, appInfo) =>
    format
      .formatCopyText({
        entries: [],
        info: appInfo,
        filters: DEFAULT_FILTERS,
        totalCount: 0,
        now: new Date(NOW),
        clock: format.fixedOffsetClock(offsetMinutes),
      })
      .split("\n")[1];
  assert.equal(
    header(0, info),
    "# App 1.2.3 · macOS aarch64 · exported 2026-05-17 18:03:22 (UTC+00:00)",
  );
  assert.equal(
    header(330, info),
    "# App 1.2.3 · macOS aarch64 · exported 2026-05-17 23:33:22 (UTC+05:30)",
  );
  assert.equal(header(-240, null), "# App unknown · exported 2026-05-17 14:03:22 (UTC\u221204:00)");
});

test("the copy keeps the newest 1,500 entries and prints them oldest to newest", () => {
  assert.equal(format.COPY_MAX_ENTRIES, 1500);
  const entries = Array.from({ length: 1600 }, (_, index) =>
    entry({
      timestampMs: local(17, 12, 0, 0) + index,
      message: `m-${String(index).padStart(4, "0")}`,
    }),
  );
  const lines = format
    .formatCopyText({
      entries,
      info,
      filters: DEFAULT_FILTERS,
      totalCount: 1600,
      now: new Date(NOW),
      clock,
    })
    .split("\n");
  assert.equal(lines.length, 4 + 1500);
  assert.equal(lines[3], "# Entries: 1,600 of 1,600 (newest 1,500 max)");
  assert.match(lines[4], / m-0100$/);
  assert.match(lines[lines.length - 1], / m-1599$/);
  const printed = lines.slice(4).map((line) => line.slice(-6));
  assert.deepEqual(printed, [...printed].sort());

  const two = format
    .formatCopyText({
      entries,
      info,
      filters: DEFAULT_FILTERS,
      totalCount: 1600,
      now: new Date(NOW),
      maxLines: 2,
      clock,
    })
    .split("\n");
  assert.equal(two[3], "# Entries: 1,600 of 1,600 (newest 2 max)");
  assert.deepEqual(
    two.slice(4).map((line) => line.slice(-6)),
    ["m-1598", "m-1599"],
  );
});

test("the exported entry count is capped by the maximum", () => {
  assert.equal(format.exportedEntryCount(1600), 1500);
  assert.equal(format.exportedEntryCount(10), 10);
  assert.equal(format.exportedEntryCount(5, 3), 3);
  assert.equal(format.exportedEntryCount(5, 0), 0);
  assert.equal(format.exportedEntryCount(5, -2), 0);
  assert.equal(format.exportedEntryCount(0), 0);
});

// ---------------------------------------------------------------------------------------------
// Filters

function dataset() {
  return [
    entry({
      id: 1,
      category: "invoke",
      source: "frontend",
      message: "create_album_with_assets ok",
      timestampMs: NOW - 90 * MINUTE,
    }),
    entry({
      id: 2,
      category: "ui",
      source: "frontend",
      message: "User opened album Holiday",
      timestampMs: NOW - 10 * MINUTE,
    }),
    entry({
      id: 3,
      category: "sync",
      message: "check_for_new_assets done in 1.2s",
      slow: true,
      timestampMs: NOW - 4 * MINUTE,
    }),
    entry({
      id: 4,
      level: "warn",
      category: "sync",
      message: "Slow page fetch",
      slow: true,
      timestampMs: NOW - 2 * MINUTE,
    }),
    entry({
      id: 5,
      level: "debug",
      category: "http",
      message: "polling tick",
      timestampMs: NOW - 30_000,
    }),
    entry({
      id: 6,
      level: "error",
      category: "http",
      message: "GET /api/albums failed: offline",
      timestampMs: NOW - 20_000,
    }),
  ];
}

const run = (changes, rows = dataset(), now = NOW) =>
  ids(filter.filterEntries(rows, filtersWith(changes), now));
const levels = (...names) => new Set(names);

test("by default errors, warnings and info are shown and debug is hidden", () => {
  assert.deepEqual([...DEFAULT_FILTERS.levels].sort(), ["error", "info", "warn"]);
  assert.equal(DEFAULT_FILTERS.category, "all");
  assert.equal(DEFAULT_FILTERS.search, "");
  assert.equal(DEFAULT_FILTERS.slowOnly, false);
  assert.equal(DEFAULT_FILTERS.range, "all");
  assert.deepEqual(run({}), [1, 2, 3, 4, 6]);
});

test("the level filter keeps exactly the selected levels", () => {
  assert.deepEqual(run({ levels: levels("error") }), [6]);
  assert.deepEqual(run({ levels: levels("debug") }), [5]);
  assert.deepEqual(run({ levels: levels("error", "debug") }), [5, 6]);
  assert.deepEqual(run({ levels: levels("error", "warn", "info", "debug") }), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(run({ levels: levels() }), []);
});

test("the category filter matches the exact category", () => {
  assert.deepEqual(run({ category: "sync" }), [3, 4]);
  assert.deepEqual(run({ category: "http", levels: levels("error", "debug") }), [5, 6]);
  assert.deepEqual(run({ category: "nope" }), []);
});

test("search is case-insensitive and covers the message, the category and the source", () => {
  assert.deepEqual(run({ search: "ALBUM" }), [1, 2, 6]);
  assert.deepEqual(run({ search: "holiday" }), [2]);
  assert.deepEqual(run({ search: "frontend" }), [1, 2]);
  assert.deepEqual(run({ search: "  SYNC " }), [3, 4]);
  assert.deepEqual(run({ search: "rust/http", levels: levels("error", "debug") }), [5, 6]);
  assert.deepEqual(run({ search: "no such text" }), []);
  assert.deepEqual(run({ search: "   " }), [1, 2, 3, 4, 6], "blank search filters nothing");
});

test("slow-only keeps the entries flagged as slow", () => {
  assert.deepEqual(run({ slowOnly: true }), [3, 4]);
  assert.deepEqual(run({ slowOnly: true, levels: levels("error") }), []);
});

test("time ranges are relative to now and include the boundary", () => {
  assert.deepEqual(run({ range: "1m" }), [6]);
  assert.deepEqual(run({ range: "5m" }), [3, 4, 6]);
  assert.deepEqual(run({ range: "15m" }), [2, 3, 4, 6]);
  assert.deepEqual(run({ range: "60m" }), [2, 3, 4, 6]);
  assert.deepEqual(run({ range: "all" }), [1, 2, 3, 4, 6]);

  const edge = [
    entry({ id: 10, timestampMs: NOW - 5 * MINUTE }),
    entry({ id: 11, timestampMs: NOW - 5 * MINUTE - 1 }),
  ];
  assert.deepEqual(run({ range: "5m" }, edge), [10]);
  assert.deepEqual(run({ range: "5m" }, dataset(), new Date(NOW)), [3, 4, 6], "Date works too");
});

test("filters combine, keep the original order and return the very same rows", () => {
  assert.deepEqual(
    run({
      levels: levels("warn", "info"),
      category: "sync",
      slowOnly: true,
      search: "page",
      range: "5m",
    }),
    [4],
  );
  const rows = dataset().map((row) => ({ ...row, rowKey: `c-${row.id}` }));
  const result = filter.filterEntries(rows, DEFAULT_FILTERS, NOW);
  assert.deepEqual(ids(result), [1, 2, 3, 4, 6]);
  assert.equal(result[0], rows[0], "extra fields survive because rows are not copied");
  assert.equal(rows.length, 6, "the input is untouched");
});

test("level counts follow every filter except the level one", () => {
  const rows = dataset();
  assert.deepEqual(JSON.parse(JSON.stringify(filter.countByLevel(rows))), {
    error: 1,
    warn: 1,
    info: 3,
    debug: 1,
  });
  const counts = (changes) =>
    JSON.parse(
      JSON.stringify(filter.countLevelsIgnoringLevelFilter(rows, filtersWith(changes), NOW)),
    );
  assert.deepEqual(counts({ levels: levels("error") }), { error: 1, warn: 1, info: 3, debug: 1 });
  assert.deepEqual(counts({ slowOnly: true }), { error: 0, warn: 1, info: 1, debug: 0 });
  assert.deepEqual(counts({ range: "1m" }), { error: 1, warn: 0, info: 0, debug: 1 });
});

test("categories are unique and sorted, and the selected one never disappears", () => {
  const rows = dataset();
  assert.deepEqual(filter.listCategories(rows), ["http", "invoke", "sync", "ui"]);
  assert.deepEqual(filter.listCategories(rows, "zzz"), ["http", "invoke", "sync", "ui", "zzz"]);
  assert.deepEqual(filter.listCategories(rows, "sync"), ["http", "invoke", "sync", "ui"]);
  assert.deepEqual(filter.listCategories(rows, "all"), ["http", "invoke", "sync", "ui"]);
  assert.deepEqual(filter.listCategories([]), []);
});

test("the filter description is what the copy header prints", () => {
  assert.equal(
    filter.describeFilters(DEFAULT_FILTERS),
    'levels=error,warn,info · category=all · slow-only=off · range=all · search=""',
  );
  assert.equal(
    filter.describeFilters(filtersWith({ range: "15m" })),
    'levels=error,warn,info · category=all · slow-only=off · range=15 min · search=""',
  );
  assert.equal(
    filter.describeFilters(
      filtersWith({
        levels: levels("debug", "error"),
        category: "sync",
        slowOnly: true,
        range: "60m",
        search: ' Ho"ly ',
      }),
    ),
    'levels=error,debug · category=sync · slow-only=on · range=60 min · search="Ho\\"ly"',
  );
  assert.match(filter.describeFilters(filtersWith({ levels: levels() })), /^levels=none · /);
  assert.match(filter.describeFilters(filtersWith({ range: "1m" })), / range=1 min · /);
  assert.match(filter.describeFilters(filtersWith({ range: "5m" })), / range=5 min · /);
});

test("level toggles are immutable and keep the reference when nothing changes", () => {
  assert.equal(filter.setLevelEnabled(DEFAULT_FILTERS, "info", true), DEFAULT_FILTERS);
  assert.equal(filter.setLevelEnabled(DEFAULT_FILTERS, "debug", false), DEFAULT_FILTERS);
  const withDebug = filter.setLevelEnabled(DEFAULT_FILTERS, "debug", true);
  assert.notEqual(withDebug, DEFAULT_FILTERS);
  assert.ok(withDebug.levels.has("debug"));
  assert.ok(!DEFAULT_FILTERS.levels.has("debug"), "the defaults are never mutated");
  assert.ok(!filter.toggleLevel(withDebug, "debug").levels.has("debug"));
  assert.ok(filter.toggleLevel(DEFAULT_FILTERS, "debug").levels.has("debug"));
  assert.ok(!filter.toggleLevel(DEFAULT_FILTERS, "error").levels.has("error"));
});

test("filters count as default only when nothing narrows the view", () => {
  assert.equal(filter.areFiltersDefault(DEFAULT_FILTERS), true);
  assert.equal(filter.areFiltersDefault(filtersWith({ search: "  " })), true);
  assert.equal(filter.areFiltersDefault(filtersWith({ search: "x" })), false);
  assert.equal(filter.areFiltersDefault(filtersWith({ slowOnly: true })), false);
  assert.equal(filter.areFiltersDefault(filtersWith({ category: "sync" })), false);
  assert.equal(filter.areFiltersDefault(filtersWith({ range: "5m" })), false);
  assert.equal(filter.areFiltersDefault(filtersWith({ levels: levels("error") })), false);
  assert.equal(filter.areFiltersDefault(filter.toggleLevel(DEFAULT_FILTERS, "debug")), false);
});

test("only the known time ranges are accepted", () => {
  for (const range of ["all", "1m", "5m", "15m", "60m"]) {
    assert.equal(filter.isActivityTimeRange(range), true);
  }
  for (const range of ["", "2m", "1h", "ALL"])
    assert.equal(filter.isActivityTimeRange(range), false);
});

// ---------------------------------------------------------------------------------------------
// Buffer

test("the window keeps at most 10,000 entries and drops the oldest first", () => {
  assert.equal(buffer.ACTIVITY_BUFFER_CAP, 10_000);
  const current = Array.from({ length: 9998 }, (_, index) =>
    buffer.toCurrentRow(entry({ id: index + 1 })),
  );
  const incoming = Array.from({ length: 5 }, (_, index) => entry({ id: 9999 + index }));
  const merged = buffer.appendEntries(current, incoming, { afterId: 9998 });
  assert.equal(merged.length, 10_000);
  assert.equal(merged[0].id, 4, "ids 1-3 were dropped");
  assert.equal(merged[merged.length - 1].id, 10_003);
  assert.equal(current.length, 9998, "the previous list is not mutated");

  const small = buffer.appendEntries(
    [buffer.toCurrentRow(entry({ id: 1 })), buffer.toCurrentRow(entry({ id: 2 }))],
    [entry({ id: 3 })],
    { afterId: 2, cap: 2 },
  );
  assert.deepEqual(ids(small), [2, 3]);
});

test("entries already merged are skipped and an unchanged list keeps its identity", () => {
  const current = [buffer.toCurrentRow(entry({ id: 1 })), buffer.toCurrentRow(entry({ id: 2 }))];
  const overlapping = [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })];
  assert.deepEqual(ids(buffer.appendEntries(current, overlapping, { afterId: 2 })), [1, 2, 3]);
  assert.equal(buffer.appendEntries(current, [], { afterId: 2 }), current);
  assert.equal(buffer.appendEntries(current, overlapping.slice(0, 2), { afterId: 2 }), current);
  const cleared = buffer.appendEntries([], overlapping, { afterId: 2 });
  assert.deepEqual(ids(cleared), [3], "after a clear the cursor keeps the old entries out");
});

test("current rows are keyed by id and earlier sessions by position", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(buffer.toCurrentRow(entry({ id: 7, message: "m" })))).rowKey,
    "c-7",
  );
  assert.equal(buffer.toCurrentRow(entry({ id: 7 })).previousSession, false);

  const history = buffer.toHistoryRows([entry({ id: 1 }), entry({ id: 2 }), entry({ id: 1 })]);
  assert.deepEqual(
    history.map((row) => row.rowKey),
    ["h-0", "h-1", "h-2"],
  );
  assert.ok(history.every((row) => row.previousSession === true));
  assert.deepEqual(ids(history), [1, 2, 1], "the original ids are kept");
});

test("history and current rows never share a key even when their ids overlap", () => {
  const history = buffer.toHistoryRows([entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })]);
  const current = [1, 2, 3].map((id) => buffer.toCurrentRow(entry({ id })));
  const combined = buffer.combineRows(history, current, true);
  assert.equal(combined.length, 6);
  assert.equal(new Set(combined.map((row) => row.rowKey)).size, 6);
  assert.deepEqual(
    combined.map((row) => row.previousSession),
    [true, true, true, false, false, false],
    "earlier sessions come first",
  );
});

test("previous sessions are left out until asked for", () => {
  const history = buffer.toHistoryRows([entry({ id: 1 })]);
  const current = [buffer.toCurrentRow(entry({ id: 1 }))];
  assert.equal(buffer.combineRows(history, current, false), current);
  assert.equal(buffer.combineRows([], current, true), current);
});

test("the poll cursor asks for everything first, then only what is new", () => {
  assert.equal(buffer.POLL_LIMIT, 10_000);
  assert.equal(buffer.HISTORY_LIMIT, 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(buffer.nextPollRequest(0))), {
    sinceId: 0,
    limit: 10_000,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(buffer.nextPollRequest(42))), {
    sinceId: 42,
    limit: 10_000,
  });
  assert.equal(buffer.nextPollRequest(-3).sinceId, 0);
});

test("a poll response is appended, and rebuilds the list when the backend restarted its numbering", () => {
  const current = [1, 2, 3].map((id) => buffer.toCurrentRow(entry({ id })));
  const request = buffer.nextPollRequest(3);
  const appended = buffer.applyPollResponse(
    current,
    { entries: [entry({ id: 4 }), entry({ id: 5 })], lastId: 5 },
    request,
  );
  assert.deepEqual(ids(appended), [1, 2, 3, 4, 5]);
  assert.equal(buffer.isCursorReset(request, { lastId: 5 }), false);

  const idle = buffer.applyPollResponse(current, { entries: [], lastId: 3 }, request);
  assert.equal(idle, current, "nothing new keeps the list identity");
  assert.equal(buffer.isCursorReset(request, { lastId: 3 }), false, "same cursor is not a reset");

  // The backend answers a cursor it never issued by numbering from scratch (lastId below the cursor).
  const stale = buffer.nextPollRequest(9999);
  const restarted = { entries: [entry({ id: 1 }), entry({ id: 2 })], lastId: 2 };
  assert.equal(buffer.isCursorReset(stale, restarted), true);
  assert.deepEqual(ids(buffer.applyPollResponse(current, restarted, stale)), [1, 2]);
  assert.deepEqual(
    ids(buffer.applyPollResponse(current, { entries: [], lastId: 0 }, stale)),
    [],
    "an empty restarted backend empties the list",
  );
});

const marker = (id, message) => buffer.toCurrentRow(entry({ id, category: "session", message }));
const START = "session started · app v1.2.3 · macOS aarch64 · pid 4242";
const END = "session ended (clean exit)";

test("session markers are recognised from their category and wording", () => {
  assert.equal(buffer.isSessionMarker(entry({ category: "session", message: START })), true);
  assert.equal(buffer.isSessionMarker(entry({ category: "sync", message: START })), false);
  assert.equal(buffer.isSessionStart(entry({ category: "session", message: START })), true);
  assert.equal(
    buffer.isSessionStart(entry({ category: "session", message: "Session Started" })),
    true,
  );
  assert.equal(buffer.isSessionStart(entry({ category: "session", message: END })), false);
  assert.equal(buffer.isSessionEnd(entry({ category: "session", message: END })), true);
  assert.equal(buffer.isSessionEnd(entry({ category: "sync", message: END })), false);
});

test("a session that starts after one that never ended is reported as an unexpected end", () => {
  const clean = [marker(1, START), marker(2, END), marker(3, START)];
  assert.deepEqual([...buffer.findUnexpectedSessionEnds(clean)], []);

  const crashed = [
    marker(1, START),
    buffer.toCurrentRow(entry({ id: 2 })),
    marker(3, START),
    marker(4, END),
    marker(5, START),
  ];
  assert.deepEqual([...buffer.findUnexpectedSessionEnds(crashed)], ["c-3"]);

  const history = buffer.toHistoryRows([entry({ category: "session", message: START }), entry()]);
  const afterCrash = buffer.combineRows(history, [marker(1, START)], true);
  assert.deepEqual([...buffer.findUnexpectedSessionEnds(afterCrash)], ["c-1"]);
  assert.deepEqual([...buffer.findUnexpectedSessionEnds([])], []);
});

// ---------------------------------------------------------------------------------------------
// List items

const rowAt = (timestampMs, overrides = {}) =>
  buffer.toCurrentRow(entry({ timestampMs, ...overrides }));

test("a date divider opens the list and every local day change", () => {
  const rows = [
    rowAt(local(16, 23, 59, 58), { id: 1 }),
    rowAt(local(17, 0, 0, 1), { id: 2 }),
    rowAt(local(17, 0, 5, 0), { id: 3 }),
  ];
  const result = listItems.buildListItems(rows, new Set(), clock);
  assert.deepEqual(
    result.map((item) => `${item.kind}:${item.key}`),
    ["date:date-c-1", "entry:c-1", "date:date-c-2", "entry:c-2", "entry:c-3"],
  );
  assert.equal(result[0].timestampMs, rows[0].timestampMs);
  assert.deepEqual(listItems.buildListItems([], new Set(), clock), []);
});

test("session markers become dividers and carry whether the previous session ended badly", () => {
  const rows = [
    rowAt(local(17, 14, 0, 0), { id: 1, category: "session", message: START }),
    rowAt(local(17, 14, 1, 0), { id: 2 }),
    rowAt(local(17, 14, 2, 0), { id: 3, category: "session", message: START }),
  ];
  const result = listItems.buildListItems(rows, new Set(["c-3"]), clock);
  assert.deepEqual(
    result.map((item) => item.kind),
    ["date", "session", "entry", "session"],
  );
  assert.equal(result[1].unexpectedEnd, false);
  assert.equal(result[3].unexpectedEnd, true);
  assert.equal(result[3].row, rows[2]);
});

test("height estimates grow with the number of message lines", () => {
  const entryItem = (message) => ({ kind: "entry", key: "k", row: rowAt(NOW, { message }) });
  assert.equal(listItems.estimateItemHeight(undefined), 32);
  assert.equal(listItems.estimateItemHeight({ kind: "date", key: "d", timestampMs: NOW }), 32);
  assert.equal(
    listItems.estimateItemHeight({
      kind: "session",
      key: "s",
      row: rowAt(NOW),
      unexpectedEnd: false,
    }),
    40,
  );
  assert.equal(
    listItems.estimateItemHeight({
      kind: "session",
      key: "s",
      row: rowAt(NOW),
      unexpectedEnd: true,
    }),
    60,
  );
  assert.equal(listItems.estimateItemHeight(entryItem("one line")), 26);
  assert.equal(listItems.estimateItemHeight(entryItem("a\nb\nc")), 62);
});

test("entries after a key are counted without the date dividers", () => {
  const rows = [
    rowAt(local(16, 23, 0, 0), { id: 1 }),
    rowAt(local(17, 1, 0, 0), { id: 2 }),
    rowAt(local(17, 2, 0, 0), { id: 3 }),
  ];
  const result = listItems.buildListItems(rows, new Set(), clock);
  assert.equal(listItems.countEntriesAfter(result, "c-1"), 2);
  assert.equal(listItems.countEntriesAfter(result, "c-3"), 0);
  assert.equal(listItems.countEntriesAfter(result, "gone"), null);
  assert.equal(listItems.countEntriesAfter([], "c-1"), null);
});

// ---------------------------------------------------------------------------------------------
// Scrolling

test("the bottom counts as reached within a small tolerance", () => {
  const at = (distance) => ({ scrollTop: 600 - distance, scrollHeight: 1000, clientHeight: 400 });
  assert.equal(scroll.BOTTOM_TOLERANCE_PX, 32);
  assert.equal(scroll.isNearBottom(at(0)), true);
  assert.equal(scroll.isNearBottom(at(32)), true);
  assert.equal(scroll.isNearBottom(at(33)), false);
  assert.equal(scroll.isNearBottom(at(100), 100), true);
  assert.equal(scroll.isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 }), true);
});

test("following resumes at the bottom, pauses on an upward scroll and otherwise holds", () => {
  const next = (following, atBottom, movedUp) =>
    scroll.nextFollowing(following, { atBottom, movedUp });
  assert.equal(next(false, true, false), true, "back at the bottom resumes");
  assert.equal(next(true, true, true), true, "up but still at the bottom keeps following");
  assert.equal(next(true, false, true), false, "scrolling up away from the bottom pauses");
  assert.equal(next(false, false, true), false);
  assert.equal(next(true, false, false), true, "growth under us never pauses");
  assert.equal(next(false, false, false), false, "scrolling down but not there yet stays paused");
});

// ---------------------------------------------------------------------------------------------
// Poll loop

const settle = () => new Promise((done) => setImmediate(done));

function createFakeTimers() {
  let nextHandle = 1;
  const timers = new Map();
  return {
    setTimer(callback, delayMs) {
      const handle = nextHandle++;
      timers.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    delays: () => Array.from(timers.values(), (timer) => timer.delayMs),
    async fire() {
      const [handle, timer] = timers.entries().next().value;
      timers.delete(handle);
      timer.callback();
      await settle();
    },
  };
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveFn, rejectFn) => {
    resolvePromise = resolveFn;
    rejectPromise = rejectFn;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createLoop(overrides = {}) {
  const timers = createFakeTimers();
  const events = [];
  let active = true;
  const loop = poller.createPollLoop({
    poll: async () => {
      events.push("poll");
    },
    isActive: () => active,
    intervalMs: 750,
    maxBackoffMs: 10_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { loop, timers, events, setActive: (value) => (active = value) };
}

test("backoff doubles the delay per failure up to the maximum", () => {
  const delays = [0, 1, 2, 3, 4, 5].map((failures) => poller.backoffDelay(750, 10_000, failures));
  assert.deepEqual(delays, [750, 1500, 3000, 6000, 10_000, 10_000]);
});

test("polls never overlap: the next one is scheduled only after the previous one settled", async () => {
  const gate = deferred();
  let calls = 0;
  const { loop, timers } = createLoop({
    poll: () => {
      calls += 1;
      return gate.promise;
    },
  });
  loop.start();
  assert.deepEqual(timers.delays(), [0]);
  await timers.fire();
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays(), [], "nothing is scheduled while a poll is in flight");
  loop.wake();
  loop.wake();
  assert.equal(calls, 1, "waking up cannot start a second poll");
  assert.deepEqual(timers.delays(), []);

  gate.resolve();
  await settle();
  assert.deepEqual(timers.delays(), [750]);
  loop.stop();
});

test("failures back off, are reported, and one success resets the pace", async () => {
  const failing = { value: true };
  const errors = [];
  let recovered = 0;
  const { loop, timers } = createLoop({
    poll: async () => {
      if (failing.value) throw new Error("backend is down");
    },
    onError: (error, failures) => errors.push([error.message, failures]),
    onRecovered: () => {
      recovered += 1;
    },
  });
  loop.start();
  const delays = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await timers.fire();
    delays.push(...timers.delays());
  }
  assert.deepEqual(delays, [1500, 3000, 6000, 10_000, 10_000]);
  assert.deepEqual(errors, [
    ["backend is down", 1],
    ["backend is down", 2],
    ["backend is down", 3],
    ["backend is down", 4],
    ["backend is down", 5],
  ]);
  assert.equal(recovered, 0);

  failing.value = false;
  await timers.fire();
  assert.equal(recovered, 1);
  assert.deepEqual(timers.delays(), [750]);
  await timers.fire();
  assert.equal(recovered, 1, "recovery is reported once");
  loop.stop();
});

test("an observer that throws cannot break polling", async () => {
  let calls = 0;
  const { loop, timers } = createLoop({
    poll: async () => {
      calls += 1;
      if (calls === 1) throw new Error("first");
    },
    onError: () => {
      throw new Error("observer bug");
    },
    onRecovered: () => {
      throw new Error("observer bug");
    },
  });
  loop.start();
  await timers.fire();
  await timers.fire();
  await timers.fire();
  assert.equal(calls, 3);
  assert.deepEqual(timers.delays(), [750]);
  loop.stop();
});

test("an inactive loop parks until it is woken, and waking twice does not stack timers", async () => {
  const { loop, timers, events, setActive } = createLoop();
  loop.start();
  await timers.fire();
  assert.deepEqual(events, ["poll"]);
  setActive(false);
  await timers.fire();
  assert.deepEqual(events, ["poll"], "hidden: the due poll is skipped");
  assert.deepEqual(timers.delays(), [], "and nothing is scheduled while parked");

  setActive(true);
  loop.wake();
  loop.wake();
  assert.deepEqual(timers.delays(), [0], "one timer, however often it is woken");
  await timers.fire();
  assert.deepEqual(events, ["poll", "poll"]);
  loop.stop();
});

test("stopping is permanent, even while a poll is in flight", async () => {
  const gate = deferred();
  let calls = 0;
  const { loop, timers } = createLoop({
    poll: () => {
      calls += 1;
      return gate.promise;
    },
  });
  loop.start();
  await timers.fire();
  loop.stop();
  gate.resolve();
  await settle();
  assert.deepEqual(timers.delays(), [], "the settled poll schedules nothing");
  loop.wake();
  assert.deepEqual(timers.delays(), []);
  assert.equal(calls, 1);

  const idle = createLoop();
  idle.loop.start();
  idle.loop.stop();
  assert.deepEqual(idle.timers.delays(), [], "stop cancels the pending timer");
});

test("exclusive tasks wait for the poll in flight, block new polls and resume polling after", async () => {
  const pollGate = deferred();
  const taskGate = deferred();
  const events = [];
  const { loop, timers } = createLoop({
    poll: () => {
      events.push("poll:start");
      return pollGate.promise.then(() => events.push("poll:end"));
    },
  });
  loop.start();
  await timers.fire();

  const first = loop.runExclusive(async () => {
    events.push("task:start");
    await taskGate.promise;
    events.push("task:end");
    return "done";
  });
  const second = loop.runExclusive(async () => {
    events.push("second");
    return "second";
  });
  await settle();
  assert.deepEqual(events, ["poll:start"], "the task waits for the poll");

  pollGate.resolve();
  await settle();
  assert.deepEqual(events, ["poll:start", "poll:end", "task:start"]);
  assert.deepEqual(timers.delays(), [], "no poll can start while a task runs");
  loop.wake();
  assert.deepEqual(timers.delays(), []);

  taskGate.resolve();
  assert.equal(await first, "done");
  assert.equal(await second, "second");
  await settle();
  assert.deepEqual(events, ["poll:start", "poll:end", "task:start", "task:end", "second"]);
  assert.deepEqual(timers.delays(), [0], "polling resumes right away");
  loop.stop();
});

test("a failing exclusive task rejects its caller and still lets polling resume", async () => {
  const { loop, timers } = createLoop();
  const outcome = loop.runExclusive(async () => {
    throw new Error("task failed");
  });
  await assert.rejects(outcome, /task failed/);
  await settle();
  assert.deepEqual(timers.delays(), [0]);
  assert.equal(await loop.runExclusive(async () => 7), 7, "later tasks still run");
  loop.stop();
});

// ---------------------------------------------------------------------------------------------
// Error text

test("failures are turned into readable text whatever Tauri rejects with", () => {
  assert.equal(describeActivityError(new Error("nope")), "nope");
  assert.equal(describeActivityError("offline: server unreachable"), "offline: server unreachable");
  assert.equal(describeActivityError({ code: 7 }), '{"code":7}');
  assert.equal(describeActivityError(undefined), "undefined");
  const circular = {};
  circular.self = circular;
  assert.equal(describeActivityError(circular), "[object Object]");
});

// ---------------------------------------------------------------------------------------------
// Labels

const { activityLogMessages } = loadModule("src/i18n/activityLog.ts", {
  "src/i18n/index": { useI18n: () => ({ locale: "en-CA" }) },
});

function shapeOf(value) {
  if (typeof value === "function") return "function";
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shapeOf(value[key])]),
    );
  }
  return typeof value;
}

function collectStrings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (typeof value === "function") found.push(value(3, 5), value("reason"));
  else if (value && typeof value === "object")
    for (const child of Object.values(value)) collectStrings(child, found);
  return found;
}

test("every label exists in both languages with the same shape", () => {
  assert.deepEqual(shapeOf(activityLogMessages["fr-CA"]), shapeOf(activityLogMessages["en-CA"]));
  for (const locale of ["en-CA", "fr-CA"]) {
    const labels = activityLogMessages[locale];
    assert.deepEqual(Object.keys(labels.levelNames).sort(), ["debug", "error", "info", "warn"]);
    assert.deepEqual(Object.keys(labels.ranges).sort(), ["15m", "1m", "5m", "60m", "all"]);
    assert.deepEqual(Object.keys(labels.errors).sort(), ["history", "poll", "verbose"]);
    for (const text of collectStrings(labels)) {
      assert.ok(typeof text === "string" && text.trim() !== "", `${locale} has a blank label`);
    }
  }
});

test("the window is titled in the UI language and French uses typographic apostrophes", () => {
  assert.equal(activityLogMessages["en-CA"].windowTitle, "Activity Log");
  assert.equal(activityLogMessages["fr-CA"].windowTitle, "Journal d\u2019activit\u00e9");
  for (const text of collectStrings(activityLogMessages["fr-CA"])) {
    assert.ok(!text.includes("'"), `fr-CA label uses a straight apostrophe: ${text}`);
  }
});

test("counters and copy confirmations pluralise", () => {
  const en = activityLogMessages["en-CA"];
  assert.equal(en.copied(1), "Copied 1 line");
  assert.equal(en.copied(1500), "Copied 1,500 lines");
  assert.equal(en.counter(1, 1), "1 of 1 entry");
  assert.equal(en.counter(412, 3017), "412 of 3,017 entries");
  assert.match(activityLogMessages["fr-CA"].counter(412, 3017), /^412 sur 3\s017 entrées$/u);
});

// ---------------------------------------------------------------------------------------------
// Hook harness: the real hook code runs on a tiny React runtime (state, refs, memos and effects
// with cleanup, no DOM) against a fake backend that follows the Rust contract.

let activeRuntime = null;

const depsChanged = (previous, next) =>
  next === undefined ||
  previous === undefined ||
  next.length !== previous.length ||
  next.some((dep, index) => !Object.is(dep, previous[index]));

function mountHook(useHook, initialProps) {
  let props = initialProps;
  let mounted = true;
  let scheduled = false;
  let cursor = 0;
  let queuedEffects = [];
  const slots = [];
  const host = { result: undefined, renders: 0 };

  const slot = (create) => {
    const index = cursor++;
    if (index === slots.length) slots.push(create());
    return slots[index];
  };

  const schedule = () => {
    if (scheduled || !mounted) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (mounted) render();
    });
  };

  const runtime = {
    useState(initial) {
      const state = slot(() => {
        const created = { value: typeof initial === "function" ? initial() : initial };
        created.set = (update) => {
          if (!mounted) return;
          const next = typeof update === "function" ? update(created.value) : update;
          if (Object.is(next, created.value)) return;
          created.value = next;
          schedule();
        };
        return created;
      });
      return [state.value, state.set];
    },
    useRef: (initial) => slot(() => ({ current: initial })),
    useMemo(factory, deps) {
      const memo = slot(() => ({ ready: false }));
      if (!memo.ready || depsChanged(memo.deps, deps)) {
        memo.value = factory();
        memo.deps = deps;
        memo.ready = true;
      }
      return memo.value;
    },
    useEffect(effect, deps) {
      const record = slot(() => ({ ran: false }));
      if (!record.ran || depsChanged(record.deps, deps))
        queuedEffects.push({ record, effect, deps });
    },
    useId: () => slot(() => ({ value: `:r${slots.length}:` })).value,
  };

  function render() {
    activeRuntime = runtime;
    cursor = 0;
    queuedEffects = [];
    try {
      host.result = useHook(props);
    } finally {
      activeRuntime = null;
    }
    host.renders += 1;
    const effects = queuedEffects;
    queuedEffects = [];
    for (const { record } of effects) {
      record.cleanup?.();
      record.cleanup = undefined;
    }
    for (const { record, effect, deps } of effects) {
      record.cleanup = effect();
      record.deps = deps;
      record.ran = true;
    }
  }

  host.setProps = (next) => {
    props = next;
    render();
  };
  host.unmount = () => {
    if (!mounted) return;
    mounted = false;
    for (const record of slots) record.cleanup?.();
  };
  render();
  return host;
}

const hookReact = {
  ...React,
  useState: (initial) => activeRuntime.useState(initial),
  useRef: (initial) => activeRuntime.useRef(initial),
  useMemo: (factory, deps) => activeRuntime.useMemo(factory, deps),
  useCallback: (callback, deps) => activeRuntime.useMemo(() => callback, deps),
  useEffect: (effect, deps) => activeRuntime.useEffect(effect, deps),
  useLayoutEffect: (effect, deps) => activeRuntime.useEffect(effect, deps),
  useId: () => activeRuntime.useId(),
};

/** Answers the log commands like the Rust side does: ids ever increase, cursors come from the app. */
function createBackend() {
  const backend = {
    entries: [],
    history: [],
    lastIssuedId: 0,
    verbose: false,
    info: { ...info },
    calls: [],
    clipboard: [],
    openedFolders: [],
    failures: new Map(),
    gates: new Map(),
    inFlight: new Map(),
    maxInFlight: new Map(),
  };

  backend.log = (overrides = {}) => {
    backend.lastIssuedId += 1;
    const logged = entry({ ...overrides, id: backend.lastIssuedId });
    backend.entries.push(logged);
    return logged;
  };
  backend.callsTo = (command) =>
    backend.calls.filter((call) => call.command === command).map((call) => call.args);
  backend.failWith = (command, error) => backend.failures.set(command, error);
  backend.recover = (command) => backend.failures.delete(command);
  /** Delays every answer to `command` until the returned function is called. */
  backend.hold = (command) => {
    const gate = deferred();
    backend.gates.set(command, gate);
    return () => {
      backend.gates.delete(command);
      gate.resolve();
    };
  };

  const handlers = {
    get_activity_log_entries: ({ sinceId, limit = 10_000 }) => {
      // A cursor from a previous numbering (higher than any issued id) starts over from zero.
      const from = sinceId > backend.lastIssuedId ? 0 : sinceId;
      const fresh = backend.entries.filter((logged) => logged.id > from);
      const entries = fresh.slice(Math.max(0, fresh.length - limit));
      const lastId = entries.length > 0 ? entries[entries.length - 1].id : from;
      return { entries, lastId, verbose: backend.verbose };
    },
    get_activity_log_history: ({ limit = 5000 } = {}) => backend.history.slice(-limit),
    get_activity_log_info: () => ({ ...backend.info, verbose: backend.verbose }),
    set_activity_log_verbose: ({ enabled }) => {
      backend.verbose = enabled;
      return enabled;
    },
    clear_activity_log: () => {
      backend.entries = [];
      backend.history = [];
    },
    copy_text_to_clipboard: ({ text }) => {
      backend.clipboard.push(text);
    },
    open_folder_in_file_explorer: ({ path }) => {
      backend.openedFolders.push(path);
    },
  };

  backend.invoke = async (command, args) => {
    backend.calls.push({ command, args });
    const running = (backend.inFlight.get(command) ?? 0) + 1;
    backend.inFlight.set(command, running);
    backend.maxInFlight.set(command, Math.max(backend.maxInFlight.get(command) ?? 0, running));
    try {
      assert.ok(handlers[command], `unexpected command ${command}`);
      const failure = backend.failures.get(command);
      // The answer is worked out when the call arrives, like a response that is slow to come back.
      const answer = failure === undefined ? handlers[command](args ?? {}) : undefined;
      const gate = backend.gates.get(command);
      if (gate) await gate.promise;
      if (failure !== undefined) throw failure;
      return structuredClone(answer);
    } finally {
      backend.inFlight.set(command, running - 1);
    }
  };
  return backend;
}

function installBrowserGlobals() {
  const timers = createFakeTimers();
  const listeners = { document: new Map(), window: new Map() };
  const intervals = new Map();
  let intervalHandle = 0;
  const target = (scope) => ({
    addEventListener: (type, listener) => {
      if (!listeners[scope].has(type)) listeners[scope].set(type, new Set());
      listeners[scope].get(type).add(listener);
    },
    removeEventListener: (type, listener) => {
      listeners[scope].get(type)?.delete(listener);
    },
  });
  const fakeDocument = { visibilityState: "visible", ...target("document") };
  const fakeWindow = {
    ...target("window"),
    setTimeout: (callback, delayMs) => timers.setTimer(callback, delayMs),
    clearTimeout: (handle) => timers.clearTimer(handle),
    setInterval: (callback, delayMs) => {
      intervalHandle += 1;
      intervals.set(intervalHandle, { callback, delayMs });
      return intervalHandle;
    },
    clearInterval: (handle) => intervals.delete(handle),
  };
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  globalThis.setTimeout = timers.setTimer;
  globalThis.clearTimeout = timers.clearTimer;
  return {
    timers,
    document: fakeDocument,
    intervals,
    listenerCount: (scope, type) => listeners[scope].get(type)?.size ?? 0,
    emit: (scope, type) => {
      for (const listener of [...(listeners[scope].get(type) ?? [])]) listener({ type });
    },
    restore() {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
    },
  };
}

/** The hooks narrate what they do; tests read that narration instead of printing it. */
function captureConsole() {
  const records = { info: [], warn: [], error: [] };
  const original = {};
  for (const level of Object.keys(records)) {
    original[level] = console[level];
    console[level] = (...args) => {
      records[level].push(args.join(" "));
    };
  }
  return {
    ...records,
    restore() {
      for (const level of Object.keys(original)) console[level] = original[level];
    },
  };
}

const windowApi = { titles: [], failure: null };
let currentBackend = null;

const hookDoubles = {
  react: hookReact,
  "@tauri-apps/api/core": { invoke: (command, args) => currentBackend.invoke(command, args) },
  "@tauri-apps/api/window": {
    getCurrentWindow: () => ({
      setTitle: async (title) => {
        if (windowApi.failure) throw windowApi.failure;
        windowApi.titles.push(title);
      },
    }),
  },
};

const activityApi = loadModule("src/api/activityLog.ts", hookDoubles);
const { useActivityLog } = loadModule("src/hooks/useActivityLog.ts", hookDoubles);
const { useActivityLogActions } = loadModule("src/hooks/useActivityLogActions.ts", hookDoubles);
const { useClearLogDialog } = loadModule("src/hooks/useClearLogDialog.ts", hookDoubles);
const { useFollowLatest } = loadModule("src/hooks/useFollowLatest.ts", hookDoubles);
const { useActivityLogView } = loadModule("src/hooks/useActivityLogView.ts", hookDoubles);

async function withHarness(body) {
  const backend = createBackend();
  const env = installBrowserGlobals();
  const logs = captureConsole();
  const hosts = [];
  currentBackend = backend;
  try {
    await body({
      backend,
      env,
      logs,
      mount(useHook, props) {
        const host = mountHook(useHook, props);
        hosts.push(host);
        return host;
      },
    });
  } finally {
    for (const host of hosts) host.unmount();
    currentBackend = null;
    logs.restore();
    env.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// useActivityLog

const rowKeys = (rows) => rows.map((row) => row.rowKey);
const pollArgs = (sinceId) => ({ sinceId, limit: 10_000 });

test("useActivityLog loads everything first, then only what is new", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    backend.log({ message: "one" });
    backend.log({ message: "two" });
    const host = mount(() => useActivityLog());
    assert.deepEqual(host.result.entries, [], "nothing is shown before the first poll");
    assert.deepEqual(env.timers.delays(), [0], "the first poll starts right away");

    await env.timers.fire();
    assert.deepEqual(rowKeys(host.result.entries), ["c-1", "c-2"]);
    assert.deepEqual(env.timers.delays(), [750], "the next poll waits for the interval");

    backend.log({ message: "three" });
    await env.timers.fire();
    assert.deepEqual(rowKeys(host.result.entries), ["c-1", "c-2", "c-3"]);
    assert.deepEqual(backend.callsTo("get_activity_log_entries"), [pollArgs(0), pollArgs(2)]);
  });
});

test("useActivityLog keeps the same list, and renders nothing, when a poll brings nothing new", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    backend.log();
    const host = mount(() => useActivityLog());
    await env.timers.fire();
    const entries = host.result.entries;
    const renders = host.renders;
    await env.timers.fire();
    await env.timers.fire();
    assert.equal(host.result.entries, entries, "an idle poll must not replace the array");
    assert.equal(host.renders, renders, "an idle poll must not re-render the window");
  });
});

test("useActivityLog never overlaps polls, even when the window is woken during one", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    const release = backend.hold("get_activity_log_entries");
    mount(() => useActivityLog());
    await env.timers.fire();
    assert.equal(backend.inFlight.get("get_activity_log_entries"), 1);

    env.emit("window", "focus");
    env.emit("document", "visibilitychange");
    assert.deepEqual(env.timers.delays(), [], "waking while a poll is pending starts nothing");

    release();
    await settle();
    assert.deepEqual(env.timers.delays(), [750]);
    assert.equal(backend.maxInFlight.get("get_activity_log_entries"), 1);
    assert.equal(backend.callsTo("get_activity_log_entries").length, 1);
  });
});

test("useActivityLog loads the app info once, retries it a few times, and keeps polling meanwhile", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    const host = mount(() => useActivityLog());
    assert.equal(host.result.info, null);
    await env.timers.fire();
    assert.deepEqual(host.result.info, { ...info, verbose: false });
    await env.timers.fire();
    assert.equal(backend.callsTo("get_activity_log_info").length, 1, "loaded once");
  });

  await withHarness(async ({ backend, env, logs, mount }) => {
    backend.failWith("get_activity_log_info", new Error("not ready"));
    const host = mount(() => useActivityLog());
    for (let poll = 0; poll < 5; poll += 1) await env.timers.fire();
    assert.equal(backend.callsTo("get_activity_log_info").length, 3, "gives up after three tries");
    assert.equal(host.result.info, null);
    assert.equal(host.result.error, null, "a missing info is not a polling error");
    assert.equal(backend.callsTo("get_activity_log_entries").length, 5, "polling carried on");
    assert.equal(logs.warn.filter((line) => line.includes("info unavailable")).length, 3);
  });
});

test("useActivityLog parks while the window is hidden and resumes when it is shown", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    env.document.visibilityState = "hidden";
    const host = mount(() => useActivityLog());
    backend.log({ message: "logged before the first look" });
    await env.timers.fire();
    assert.equal(host.result.entries.length, 1, "the first load never leaves the window empty");

    await env.timers.fire();
    assert.deepEqual(env.timers.delays(), [], "a hidden window stops polling");
    assert.equal(backend.callsTo("get_activity_log_entries").length, 1);

    backend.log({ message: "logged while hidden" });
    env.document.visibilityState = "visible";
    env.emit("document", "visibilitychange");
    assert.deepEqual(env.timers.delays(), [0], "showing the window polls at once");
    await env.timers.fire();
    assert.equal(host.result.entries.length, 2);

    env.document.visibilityState = "hidden";
    await env.timers.fire();
    env.emit("window", "focus");
    assert.deepEqual(env.timers.delays(), [0], "focus also wakes a parked loop");
  });
});

test("useActivityLog stops completely on unmount: no timers, no listeners, late answers ignored", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    const release = backend.hold("get_activity_log_entries");
    const host = mount(() => useActivityLog());
    await env.timers.fire();
    assert.equal(env.listenerCount("document", "visibilitychange"), 1);
    assert.equal(env.listenerCount("window", "focus"), 1);

    host.unmount();
    assert.equal(env.listenerCount("document", "visibilitychange"), 0);
    assert.equal(env.listenerCount("window", "focus"), 0);

    release();
    await settle();
    assert.deepEqual(env.timers.delays(), [], "no poll is scheduled after unmount");
    assert.equal(backend.callsTo("get_activity_log_info").length, 0, "the late answer is dropped");
  });
});

test("useActivityLog clears the list but keeps the cursor, so only newer entries follow", async () => {
  await withHarness(async ({ backend, env, logs, mount }) => {
    for (const message of ["a", "b", "c"]) backend.log({ message });
    const host = mount(() => useActivityLog());
    await env.timers.fire();
    assert.equal(host.result.entries.length, 3);

    await host.result.clear();
    await settle();
    assert.equal(backend.callsTo("clear_activity_log").length, 1);
    assert.deepEqual(host.result.entries, []);
    assert.deepEqual(env.timers.delays(), [0], "polling resumes right after a clear");

    backend.log({ message: "after the clear" });
    await env.timers.fire();
    assert.deepEqual(backend.callsTo("get_activity_log_entries").at(-1), pollArgs(3));
    assert.deepEqual(rowKeys(host.result.entries), ["c-4"]);
    assert.ok(logs.info.some((line) => line.includes("activity log cleared")));
  });
});

test("useActivityLog keeps everything on screen when the backend cannot clear", async () => {
  await withHarness(async ({ backend, env, logs, mount }) => {
    backend.log();
    backend.log();
    const host = mount(() => useActivityLog());
    await env.timers.fire();

    backend.failWith("clear_activity_log", new Error("log folder is read-only"));
    await assert.rejects(() => host.result.clear(), /log folder is read-only/);
    await settle();
    assert.equal(host.result.entries.length, 2, "nothing disappears when clearing failed");
    assert.deepEqual(env.timers.delays(), [0], "polling still resumes");
    assert.ok(logs.error.some((line) => line.includes("clearing failed: log folder is read-only")));
  });
});

test("useActivityLog loads previous sessions lazily, once, keyed by position", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    backend.history = [entry({ id: 1, message: "old a" }), entry({ id: 2, message: "old b" })];
    backend.log({ message: "current" });
    const host = mount(() => useActivityLog());
    await env.timers.fire();
    assert.equal(backend.callsTo("get_activity_log_history").length, 0, "not loaded until asked");
    assert.equal(host.result.historyEnabled, false);

    const release = backend.hold("get_activity_log_history");
    host.result.setHistoryEnabled(true);
    await settle();
    assert.equal(host.result.historyEnabled, true);
    assert.equal(host.result.historyLoading, true);

    release();
    await settle();
    assert.equal(host.result.historyLoading, false);
    assert.deepEqual(rowKeys(host.result.historyEntries), ["h-0", "h-1"]);
    assert.ok(host.result.historyEntries.every((row) => row.previousSession));
    assert.deepEqual(rowKeys(host.result.entries), ["c-1"], "current rows keep their own keys");
    assert.deepEqual(backend.callsTo("get_activity_log_history"), [{ limit: 5000 }]);

    host.result.setHistoryEnabled(false);
    await settle();
    assert.equal(host.result.historyEnabled, false);
    assert.equal(host.result.historyEntries.length, 2, "switching it off only hides them");
    host.result.setHistoryEnabled(true);
    await settle();
    assert.equal(backend.callsTo("get_activity_log_history").length, 1, "never loaded twice");
  });
});

test("useActivityLog reports a failed history load and retries when the switch is used again", async () => {
  await withHarness(async ({ backend, env, logs, mount }) => {
    backend.history = [entry({ id: 1, message: "old" })];
    const host = mount(() => useActivityLog());
    await env.timers.fire();

    backend.failWith("get_activity_log_history", new Error("log files unreadable"));
    host.result.setHistoryEnabled(true);
    await settle();
    assert.equal(host.result.historyLoading, false);
    assert.equal(host.result.historyEnabled, true);
    assert.deepEqual(host.result.error, { kind: "history", message: "log files unreadable" });
    assert.ok(logs.error.some((line) => line.includes("log files unreadable")));

    backend.recover("get_activity_log_history");
    host.result.setHistoryEnabled(false);
    host.result.setHistoryEnabled(true);
    await settle();
    assert.equal(host.result.error, null);
    assert.deepEqual(rowKeys(host.result.historyEntries), ["h-0"]);
  });
});

test("useActivityLog drops a history answer that arrives after the log was cleared", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    backend.history = [entry({ id: 1, message: "old" })];
    const host = mount(() => useActivityLog());
    await env.timers.fire();

    const release = backend.hold("get_activity_log_history");
    host.result.setHistoryEnabled(true);
    await settle();
    await host.result.clear();
    release();
    await settle();
    assert.deepEqual(host.result.historyEntries, [], "the stale answer is not shown");
    assert.equal(host.result.historyLoading, false);

    host.result.setHistoryEnabled(false);
    host.result.setHistoryEnabled(true);
    await settle();
    assert.equal(backend.callsTo("get_activity_log_history").length, 1, "nothing left to reload");
  });
});

test("useActivityLog switches verbose logging through the backend and stays in sync with it", async () => {
  await withHarness(async ({ backend, env, logs, mount }) => {
    const host = mount(() => useActivityLog());
    await env.timers.fire();
    assert.equal(host.result.verbose, false);

    assert.equal(await host.result.setVerbose(true), true);
    await settle();
    assert.deepEqual(backend.callsTo("set_activity_log_verbose"), [{ enabled: true }]);
    assert.equal(host.result.verbose, true);
    assert.ok(logs.info.some((line) => line.includes("verbose logging on")));

    backend.verbose = false;
    await env.timers.fire();
    assert.equal(host.result.verbose, false, "each poll keeps the switch honest");
  });
});

test("useActivityLog keeps the previous verbose state and says so when the switch fails", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    const host = mount(() => useActivityLog());
    await env.timers.fire();

    backend.failWith("set_activity_log_verbose", new Error("backend busy"));
    assert.equal(
      await host.result.setVerbose(true),
      false,
      "never rejects, reports what is in effect",
    );
    await settle();
    assert.equal(host.result.verbose, false);
    assert.deepEqual(host.result.error, { kind: "verbose", message: "backend busy" });

    backend.recover("set_activity_log_verbose");
    assert.equal(await host.result.setVerbose(true), true);
    await settle();
    assert.equal(host.result.error, null, "a later success clears the message");
    assert.equal(host.result.verbose, true);
  });
});

test("useActivityLog surfaces polling failures, backs off, and recovers by itself", async () => {
  await withHarness(async ({ backend, env, logs, mount }) => {
    backend.log();
    const host = mount(() => useActivityLog());
    await env.timers.fire();
    assert.equal(host.result.error, null);

    backend.failWith("get_activity_log_entries", new Error("ipc channel closed"));
    await env.timers.fire();
    assert.deepEqual(host.result.error, { kind: "poll", message: "ipc channel closed" });
    assert.deepEqual(env.timers.delays(), [1500]);
    await env.timers.fire();
    assert.deepEqual(env.timers.delays(), [3000]);
    assert.equal(host.result.entries.length, 1, "what was loaded stays visible");
    assert.equal(
      logs.error.filter((line) => line.includes("polling failed")).length,
      1,
      "only the first failure in a row is logged",
    );

    backend.recover("get_activity_log_entries");
    backend.log({ message: "back online" });
    await env.timers.fire();
    assert.equal(host.result.error, null);
    assert.deepEqual(env.timers.delays(), [750]);
    assert.equal(host.result.entries.length, 2);
    assert.ok(logs.info.some((line) => line.includes("polling recovered")));
  });
});

test("useActivityLog rebuilds its list when the backend numbers its entries from scratch", async () => {
  await withHarness(async ({ backend, env, logs, mount }) => {
    for (const message of ["a", "b", "c"]) backend.log({ message });
    const host = mount(() => useActivityLog());
    await env.timers.fire();
    assert.equal(host.result.entries.length, 3);

    backend.entries = [];
    backend.lastIssuedId = 0;
    backend.log({ message: "after the restart" });
    await env.timers.fire();
    assert.deepEqual(
      host.result.entries.map((row) => [row.rowKey, row.message]),
      [["c-1", "after the restart"]],
    );
    assert.ok(logs.warn.some((line) => line.includes("renumbered")));

    backend.log({ message: "and then more" });
    await env.timers.fire();
    assert.deepEqual(backend.callsTo("get_activity_log_entries").at(-1), pollArgs(1));
    assert.deepEqual(rowKeys(host.result.entries), ["c-1", "c-2"]);
  });
});

// ---------------------------------------------------------------------------------------------
// useActivityLogActions

const rowsOf = (count, overrides = {}) =>
  Array.from({ length: count }, (_, index) =>
    buffer.toCurrentRow(
      entry({ id: index + 1, timestampMs: NOW + index, message: `row ${index}`, ...overrides }),
    ),
  );

const actionProps = (overrides = {}) => ({
  visibleRows: rowsOf(3),
  totalCount: 5,
  info,
  filters: DEFAULT_FILTERS,
  ...overrides,
});

const isEntryLine = (line) => /^\d{2}:\d{2}:\d{2}\.\d{3} /.test(line);

test("Copy sends the filtered view through the Tauri clipboard command and confirms the count", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    const host = mount(useActivityLogActions, actionProps());
    assert.equal(host.result.status, null);

    await host.result.copy();
    await settle();
    const calls = backend.callsTo("copy_text_to_clipboard");
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]), ["text"]);
    const lines = calls[0].text.split("\n");
    assert.equal(lines[0], "# Immich Local \u2014 Activity Log");
    assert.match(
      lines[1],
      /^# App 1\.2\.3 · macOS aarch64 · exported \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+\u2212]\d{2}:\d{2}\)$/u,
    );
    assert.equal(
      lines[2],
      '# Filters: levels=error,warn,info · category=all · slow-only=off · range=all · search=""',
    );
    assert.equal(lines[3], "# Entries: 3 of 5 (newest 1,500 max)");
    assert.equal(lines.filter(isEntryLine).length, 3);
    assert.deepEqual(host.result.status, { kind: "copied", count: 3 });

    assert.deepEqual(env.timers.delays(), [3000]);
    await env.timers.fire();
    assert.equal(host.result.status, null, "the confirmation fades by itself");
  });
});

test("Copy exports at most the newest 1,500 entries and says how many it copied", async () => {
  await withHarness(async ({ backend, mount }) => {
    const host = mount(
      useActivityLogActions,
      actionProps({ visibleRows: rowsOf(1600), totalCount: 1600 }),
    );
    await host.result.copy();
    await settle();
    assert.deepEqual(host.result.status, { kind: "copied", count: 1500 });
    const lines = backend.callsTo("copy_text_to_clipboard")[0].text.split("\n");
    assert.equal(lines.filter(isEntryLine).length, 1500);
    assert.ok(
      lines.some((line) => line.endsWith(" row 100")),
      "the newest 1,500 start at row 100",
    );
    assert.ok(!lines.some((line) => line.endsWith(" row 99")));
    assert.ok(lines.some((line) => line.endsWith(" row 1599")));
  });
});

test("Copy follows the filters and totals it was given, and works before the app info is known", async () => {
  await withHarness(async ({ backend, mount }) => {
    const host = mount(
      useActivityLogActions,
      actionProps({
        info: null,
        totalCount: 40,
        filters: { ...DEFAULT_FILTERS, slowOnly: true, search: "sync" },
      }),
    );
    await host.result.copy();
    await settle();
    const lines = backend.callsTo("copy_text_to_clipboard")[0].text.split("\n");
    assert.match(lines[1], /^# App unknown · exported /u);
    assert.equal(
      lines[2],
      '# Filters: levels=error,warn,info · category=all · slow-only=on · range=all · search="sync"',
    );
    assert.equal(lines[3], "# Entries: 3 of 40 (newest 1,500 max)");
  });
});

test("a failed copy is reported and logged, and leaves nothing behind", async () => {
  await withHarness(async ({ backend, env, logs, mount }) => {
    backend.failWith("copy_text_to_clipboard", new Error("clipboard unavailable"));
    const host = mount(useActivityLogActions, actionProps());
    await host.result.copy();
    await settle();
    assert.deepEqual(host.result.status, { kind: "copy-failed" });
    assert.deepEqual(backend.clipboard, []);
    assert.ok(logs.error.some((line) => line.includes("copy failed: clipboard unavailable")));
    await env.timers.fire();
    assert.equal(host.result.status, null);
  });
});

test("a newer status restarts the countdown and unmounting cancels it", async () => {
  await withHarness(async ({ env, mount }) => {
    const host = mount(useActivityLogActions, actionProps());
    await host.result.copy();
    await settle();
    await host.result.copy();
    await settle();
    assert.deepEqual(env.timers.delays(), [3000], "one countdown, not two");
    host.unmount();
    assert.deepEqual(env.timers.delays(), [], "nothing fires after unmount");
  });
});

test("a copy that finishes after the window closed touches nothing", async () => {
  await withHarness(async ({ backend, env, mount }) => {
    const release = backend.hold("copy_text_to_clipboard");
    const host = mount(useActivityLogActions, actionProps());
    const pending = host.result.copy();
    host.unmount();
    release();
    await pending;
    assert.deepEqual(env.timers.delays(), []);
  });
});

test("Open log folder passes the log directory and does nothing before it is known", async () => {
  await withHarness(async ({ backend, logs, mount }) => {
    const host = mount(useActivityLogActions, actionProps({ info: null }));
    await host.result.openFolder();
    assert.equal(backend.callsTo("open_folder_in_file_explorer").length, 0);

    host.setProps(actionProps());
    await host.result.openFolder();
    await settle();
    assert.deepEqual(backend.callsTo("open_folder_in_file_explorer"), [{ path: info.logDir }]);
    assert.equal(host.result.status, null, "success needs no message");

    backend.failWith("open_folder_in_file_explorer", new Error("no file manager"));
    await host.result.openFolder();
    await settle();
    assert.deepEqual(host.result.status, { kind: "open-failed" });
    assert.ok(logs.error.some((line) => line.includes("no file manager")));
  });
});

// ---------------------------------------------------------------------------------------------
// useClearLogDialog

function clearDialogProps(overrides = {}) {
  const calls = { cleared: 0 };
  return {
    calls,
    props: {
      clear: async () => {
        calls.cleared += 1;
      },
      describeFailure: (reason) => `could not clear: ${reason}`,
      ...overrides,
    },
  };
}

test("the clear dialog opens on request and Cancel closes it without clearing", async () => {
  await withHarness(async ({ mount }) => {
    const { calls, props } = clearDialogProps();
    const host = mount(useClearLogDialog, props);
    assert.equal(host.result.open, false);

    host.result.request();
    await settle();
    assert.equal(host.result.open, true);

    host.result.cancel();
    await settle();
    assert.equal(host.result.open, false);
    assert.equal(calls.cleared, 0, "cancelling never clears");
  });
});

test("confirming clears once and closes, and ignores a second confirm or a cancel while busy", async () => {
  await withHarness(async ({ mount }) => {
    const gate = deferred();
    const { calls, props } = clearDialogProps({
      clear: async () => {
        calls.cleared += 1;
        await gate.promise;
      },
    });
    const host = mount(useClearLogDialog, props);
    host.result.request();
    await settle();

    const first = host.result.confirm();
    const second = host.result.confirm();
    await settle();
    assert.equal(host.result.busy, true);
    assert.equal(calls.cleared, 1, "a double click clears once");

    host.result.cancel();
    await settle();
    assert.equal(host.result.open, true, "the dialog cannot be dismissed mid-clear");

    gate.resolve();
    await Promise.all([first, second]);
    await settle();
    assert.equal(host.result.open, false);
    assert.equal(host.result.busy, false);
    assert.equal(host.result.error, null);
  });
});

test("a failed clear keeps the dialog open with the reason, and Cancel resets it", async () => {
  await withHarness(async ({ mount }) => {
    const { props } = clearDialogProps({
      clear: async () => {
        throw new Error("log folder is read-only");
      },
    });
    const host = mount(useClearLogDialog, props);
    host.result.request();
    await settle();
    await host.result.confirm();
    await settle();
    assert.equal(host.result.open, true);
    assert.equal(host.result.busy, false);
    assert.equal(host.result.error, "could not clear: log folder is read-only");

    host.result.cancel();
    await settle();
    assert.equal(host.result.open, false);
    assert.equal(host.result.error, null);

    host.result.request();
    await settle();
    assert.equal(host.result.error, null, "a reopened dialog starts clean");
  });
});

test("a clear that finishes after the window closed touches nothing", async () => {
  await withHarness(async ({ mount }) => {
    const gate = deferred();
    const { props } = clearDialogProps({ clear: () => gate.promise });
    const host = mount(useClearLogDialog, props);
    host.result.request();
    await settle();
    const pending = host.result.confirm();
    host.unmount();
    gate.resolve();
    await pending;
  });
});

// ---------------------------------------------------------------------------------------------
// useFollowLatest

function createScroller({ scrollHeight, clientHeight }) {
  let top = 0;
  const scroller = {
    scrollHeight,
    clientHeight,
    get scrollTop() {
      return top;
    },
    set scrollTop(value) {
      top = Math.max(0, Math.min(value, scroller.scrollHeight - scroller.clientHeight));
    },
  };
  return scroller;
}

function installResizeObserver() {
  const observers = [];
  const saved = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(element) {
      this.observed.push(element);
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  return {
    observers,
    restore() {
      if (saved === undefined) delete globalThis.ResizeObserver;
      else globalThis.ResizeObserver = saved;
    },
  };
}

function followProps(scroller, overrides = {}) {
  return {
    containerRef: { current: scroller },
    contentHeight: scroller.scrollHeight,
    latestKey: "c-5",
    resetSignal: 0,
    ...overrides,
  };
}

test("useFollowLatest starts at the newest entry and stays there while content grows", async () => {
  await withHarness(async ({ mount }) => {
    const scroller = createScroller({ scrollHeight: 1000, clientHeight: 400 });
    const props = followProps(scroller);
    const host = mount(useFollowLatest, props);
    assert.equal(scroller.scrollTop, 600);
    assert.equal(host.result.following, true);
    assert.equal(host.result.pausedAtKey, null);

    scroller.scrollHeight = 1400;
    host.setProps({ ...props, contentHeight: 1400, latestKey: "c-6" });
    assert.equal(scroller.scrollTop, 1000, "new entries stay in view");
  });
});

test("useFollowLatest pauses on an upward scroll, remembers where, and Jump to latest resumes", async () => {
  await withHarness(async ({ mount }) => {
    const scroller = createScroller({ scrollHeight: 1000, clientHeight: 400 });
    const props = followProps(scroller);
    const host = mount(useFollowLatest, props);
    host.result.onScroll(); // the scroll event the browser fires for the initial pin
    scroller.scrollTop = 100;
    host.result.onScroll();
    await settle();
    assert.equal(host.result.following, false);
    assert.equal(host.result.pausedAtKey, "c-5");

    scroller.scrollHeight = 1800;
    host.setProps({ ...props, contentHeight: 1800, latestKey: "c-9" });
    assert.equal(scroller.scrollTop, 100, "the reading position is left alone");
    assert.equal(host.result.pausedAtKey, "c-5", "new entries are counted from where it paused");

    host.result.jumpToLatest();
    await settle();
    assert.equal(host.result.following, true);
    assert.equal(host.result.pausedAtKey, null);
    assert.equal(scroller.scrollTop, 1400);
  });
});

test("useFollowLatest resumes by itself when the user scrolls back to the bottom", async () => {
  await withHarness(async ({ mount }) => {
    const scroller = createScroller({ scrollHeight: 1000, clientHeight: 400 });
    const host = mount(useFollowLatest, followProps(scroller));
    host.result.onScroll();
    scroller.scrollTop = 100;
    host.result.onScroll();
    await settle();
    assert.equal(host.result.following, false);

    scroller.scrollTop = 590;
    host.result.onScroll();
    await settle();
    assert.equal(host.result.following, true, "within the bottom tolerance counts as the bottom");
  });
});

test("useFollowLatest resumes and re-pins when the filters change", async () => {
  await withHarness(async ({ mount }) => {
    const scroller = createScroller({ scrollHeight: 1000, clientHeight: 400 });
    const props = followProps(scroller);
    const host = mount(useFollowLatest, props);
    host.result.onScroll();
    scroller.scrollTop = 100;
    host.result.onScroll();
    await settle();
    assert.equal(host.result.following, false);

    host.setProps({ ...props, resetSignal: 1 });
    await settle();
    assert.equal(host.result.following, true);
    assert.equal(scroller.scrollTop, 600);
  });
});

test("useFollowLatest re-pins on resize only while following, and stops observing on unmount", async () => {
  const resize = installResizeObserver();
  try {
    await withHarness(async ({ mount }) => {
      const scroller = createScroller({ scrollHeight: 1000, clientHeight: 400 });
      const host = mount(useFollowLatest, followProps(scroller));
      assert.equal(resize.observers.length, 1);
      assert.deepEqual(resize.observers[0].observed, [scroller]);

      scroller.clientHeight = 300;
      resize.observers[0].callback();
      assert.equal(scroller.scrollTop, 700, "a shorter window keeps the newest row visible");

      host.result.onScroll();
      scroller.scrollTop = 100;
      host.result.onScroll();
      await settle();
      scroller.clientHeight = 250;
      resize.observers[0].callback();
      assert.equal(scroller.scrollTop, 100, "a paused reader is not moved");

      host.unmount();
      assert.equal(resize.observers[0].disconnected, true);
    });
  } finally {
    resize.restore();
  }
});

// ---------------------------------------------------------------------------------------------
// useActivityLogView

test("useActivityLogView combines, filters and counts rows, and only ticks for relative ranges", async () => {
  await withHarness(async ({ env, mount }) => {
    const current = [
      entry({ id: 1, level: "info", category: "sync", timestampMs: NOW - 2 * MINUTE }),
      entry({ id: 2, level: "error", category: "http", timestampMs: NOW - 30_000 }),
      entry({ id: 3, level: "debug", category: "sync", timestampMs: NOW - 10_000 }),
    ].map(buffer.toCurrentRow);
    const previous = buffer.toHistoryRows([
      entry({ id: 1, level: "warn", category: "indexer", timestampMs: NOW - 90 * MINUTE }),
    ]);
    const props = {
      entries: current,
      historyEntries: previous,
      includeHistory: false,
      filters: DEFAULT_FILTERS,
    };
    const host = mount(useActivityLogView, props);

    assert.equal(
      host.result.allRows,
      current,
      "without previous sessions the list is the same array",
    );
    assert.deepEqual(ids(host.result.visibleRows), [1, 2], "debug is hidden by default");
    assert.deepEqual(host.result.levelCounts, { error: 1, warn: 0, info: 1, debug: 1 });
    assert.deepEqual(host.result.categories, ["http", "sync"]);
    assert.equal(host.result.items[0].kind, "date");
    assert.equal(env.intervals.size, 0, "no timer for an absolute view");

    host.setProps({ ...props, includeHistory: true });
    assert.deepEqual(rowKeys(host.result.allRows), ["h-0", "c-1", "c-2", "c-3"]);
    assert.deepEqual(host.result.categories, ["http", "indexer", "sync"]);
    assert.deepEqual(host.result.levelCounts, { error: 1, warn: 1, info: 1, debug: 1 });

    host.setProps({ ...props, includeHistory: true, filters: filtersWith({ range: "5m" }) });
    assert.equal(env.intervals.size, 1, "relative ranges re-evaluate now() on a timer");
    assert.equal([...env.intervals.values()][0].delayMs, 5000);

    host.setProps({ ...props, includeHistory: true, filters: DEFAULT_FILTERS });
    assert.equal(env.intervals.size, 0, "the timer goes away with the relative range");

    host.setProps({ ...props, filters: filtersWith({ range: "15m" }) });
    host.unmount();
    assert.equal(env.intervals.size, 0, "and with the window");
  });
});

// ---------------------------------------------------------------------------------------------
// API wrappers

test("the API wrappers call the contract commands with exactly the contract arguments", async () => {
  await withHarness(async ({ backend }) => {
    backend.log({ message: "one" });
    const response = await activityApi.getActivityLogEntries({ sinceId: 0, limit: 25 });
    assert.deepEqual(ids(response.entries), [1]);
    assert.equal(response.lastId, 1);
    await activityApi.getActivityLogEntries({ sinceId: 4 });
    await activityApi.getActivityLogHistory();
    await activityApi.getActivityLogHistory(100);
    assert.equal((await activityApi.getActivityLogInfo()).logDir, info.logDir);
    assert.equal(await activityApi.setActivityLogVerbose(true), true);
    await activityApi.clearActivityLog();
    await activityApi.copyTextToClipboard("hello\nworld");
    await activityApi.openLogFolder("/Users/someone/Library/Logs/immich-local");

    assert.deepEqual(backend.calls, [
      { command: "get_activity_log_entries", args: { sinceId: 0, limit: 25 } },
      { command: "get_activity_log_entries", args: { sinceId: 4 } },
      { command: "get_activity_log_history", args: {} },
      { command: "get_activity_log_history", args: { limit: 100 } },
      { command: "get_activity_log_info", args: undefined },
      { command: "set_activity_log_verbose", args: { enabled: true } },
      { command: "clear_activity_log", args: undefined },
      { command: "copy_text_to_clipboard", args: { text: "hello\nworld" } },
      {
        command: "open_folder_in_file_explorer",
        args: { path: "/Users/someone/Library/Logs/immich-local" },
      },
    ]);
  });
});

test("API failures reach the caller untouched", async () => {
  await withHarness(async ({ backend }) => {
    backend.failWith("get_activity_log_entries", "offline: server unreachable");
    await assert.rejects(activityApi.getActivityLogEntries({ sinceId: 0 }), (error) => {
      assert.equal(error, "offline: server unreachable");
      return true;
    });
  });
});

test("the window title is set best-effort: a missing Tauri runtime never throws", async () => {
  windowApi.titles.length = 0;
  windowApi.failure = null;
  await activityApi.setActivityLogWindowTitle("Journal d\u2019activit\u00e9");
  assert.deepEqual(windowApi.titles, ["Journal d\u2019activit\u00e9"]);

  windowApi.failure = new Error("window.set_title not allowed");
  try {
    await activityApi.setActivityLogWindowTitle("Activity Log");
  } finally {
    windowApi.failure = null;
  }
  assert.deepEqual(windowApi.titles, ["Journal d\u2019activit\u00e9"], "nothing else was set");
});

// ---------------------------------------------------------------------------------------------
// Components: the element tree is read directly, so no DOM is needed for what they decide.

function findAll(node, matches, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, matches, found);
  } else if (node && typeof node === "object" && "props" in node) {
    if (matches(node)) found.push(node);
    findAll(node.props.children, matches, found);
  }
  return found;
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

/** Runs `body` with browser globals in place, then puts back exactly what was there before. */
function withGlobals(values, body) {
  const saved = Object.keys(values).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  Object.assign(globalThis, values);
  try {
    return body();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/** Calls ClearLogDialog as a plain function (hooks faked) so its element tree can be inspected. */
function renderClearDialog(props = {}, locale = "en-CA") {
  const effects = [];
  let nextId = 0;
  const { ClearLogDialog } = loadModule("src/components/ActivityLog/ClearLogDialog.tsx", {
    react: {
      ...React,
      useRef: (current) => ({ current }),
      useEffect: (effect, deps) => {
        effects.push({ effect, deps });
      },
      useId: () => `id-${(nextId += 1)}`,
    },
    "react-dom": { createPortal: (node) => node },
    "lucide-react": { TriangleAlert: () => null },
    "src/i18n/index": { useI18n: () => ({ locale }) },
  });
  const calls = [];
  const dialog = withGlobals({ document: { body: {} } }, () =>
    ClearLogDialog({
      busy: false,
      error: null,
      onConfirm: () => calls.push("confirm"),
      onClose: () => calls.push("close"),
      ...props,
    }),
  );
  const buttons = findAll(dialog, (node) => node.type === "button");
  const [backdrop] = findAll(
    findAll(dialog, (node) => node.type === "form")[0],
    (node) => node.type === "button",
  );
  return {
    calls,
    dialog,
    effects,
    text: textOf(dialog),
    cancel: buttons.find((button) => button.props.className === "btn"),
    confirm: buttons.find((button) => button.props.className.includes("btn-error")),
    backdrop,
  };
}

test("the clear dialog says what will be deleted and routes Cancel, the backdrop and Clear", () => {
  const labels = activityLogMessages["en-CA"].dialog;
  const view = renderClearDialog();
  assert.ok(view.text.includes(labels.title));
  assert.ok(view.text.includes(labels.body));
  assert.match(labels.body, /disk|saved|file/i, "the body admits the saved files go too");

  view.cancel.props.onClick();
  assert.deepEqual(view.calls, ["close"], "Cancel only closes");
  view.backdrop.props.onClick();
  assert.deepEqual(view.calls, ["close", "close"], "clicking outside only closes");
  assert.equal(view.dialog.props["aria-busy"], false);
  view.confirm.props.onClick();
  assert.deepEqual(view.calls, ["close", "close", "confirm"]);
  assert.equal(textOf(view.confirm), labels.confirm);
  assert.deepEqual(
    findAll(view.dialog, (node) => node.props.role === "alert"),
    [],
    "no error is shown before something fails",
  );
});

test("the clear dialog is a labelled in-app modal built from daisyUI parts", () => {
  const view = renderClearDialog();
  const title = findAll(view.dialog, (node) => node.type === "h3")[0];
  const description = findAll(view.dialog, (node) => node.type === "p" && node.props.id)[0];
  assert.equal(view.dialog.type, "dialog");
  assert.equal(view.dialog.props.className, "modal");
  assert.equal(view.dialog.props["aria-labelledby"], title.props.id);
  assert.equal(view.dialog.props["aria-describedby"], description.props.id);
  assert.notEqual(title.props.id, description.props.id);
  assert.equal(
    findAll(view.dialog, (node) => node.props.className?.includes("modal-box")).length,
    1,
  );
  assert.equal(findAll(view.dialog, (node) => node.props.className === "modal-action").length, 1);
  const backdrop = findAll(view.dialog, (node) => node.type === "form")[0];
  assert.equal(backdrop.props.className, "modal-backdrop");
  assert.equal(backdrop.props.method, "dialog");
  assert.equal(view.backdrop.props.type, "button", "the backdrop never submits anything");
  assert.equal(view.backdrop.props["aria-label"], activityLogMessages["en-CA"].dialog.cancel);
});

test("Escape cancels the clear dialog unless a clear is in flight, and never closes it natively", () => {
  for (const [busy, expectedCalls] of [
    [false, ["close"]],
    [true, []],
  ]) {
    const view = renderClearDialog({ busy });
    let prevented = 0;
    view.dialog.props.onCancel({ preventDefault: () => (prevented += 1) });
    assert.equal(prevented, 1, "the browser's own close is always intercepted");
    assert.deepEqual(view.calls, expectedCalls);
  }
});

test("while clearing, every way out is disabled and the progress is announced", () => {
  const labels = activityLogMessages["en-CA"].dialog;
  const view = renderClearDialog({ busy: true });
  assert.equal(view.cancel.props.disabled, true);
  assert.equal(view.confirm.props.disabled, true);
  assert.equal(view.backdrop.props.disabled, true);
  assert.equal(view.dialog.props["aria-busy"], true);
  assert.equal(textOf(view.confirm), labels.confirming);
  assert.equal(
    findAll(view.confirm, (node) => node.props.className?.includes("loading-spinner")).length,
    1,
  );

  const idle = renderClearDialog();
  assert.equal(idle.cancel.props.disabled, false);
  assert.equal(idle.confirm.props.disabled, false);
  assert.equal(idle.backdrop.props.disabled, false);
  assert.equal(
    findAll(idle.confirm, (node) => node.props.className?.includes("loading-spinner")).length,
    0,
  );
});

test("a failed clear keeps the dialog open, says why, and can be retried", () => {
  const reason = activityLogMessages["en-CA"].dialog.failed("disk is full");
  const view = renderClearDialog({ error: reason });
  const [alert] = findAll(view.dialog, (node) => node.props.role === "alert");
  assert.equal(textOf(alert), reason);
  assert.equal(view.confirm.props.disabled, false);
  assert.equal(view.cancel.props.disabled, false);
});

test("keys typed in the clear dialog never reach the log underneath", () => {
  const view = renderClearDialog();
  let stopped = 0;
  view.dialog.props.onKeyDown({ stopPropagation: () => (stopped += 1) });
  assert.equal(stopped, 1);
});

test("the clear dialog is written in the app language", () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    const labels = activityLogMessages[locale].dialog;
    const view = renderClearDialog({ error: labels.failed("x") }, locale);
    assert.ok(view.text.includes(labels.title), `${locale} title`);
    assert.ok(view.text.includes(labels.body), `${locale} body`);
    assert.ok(view.text.includes(labels.failed("x")), `${locale} failure`);
    assert.equal(textOf(view.confirm), labels.confirm);
    assert.equal(textOf(view.cancel), labels.cancel);
  }
  assert.notEqual(
    activityLogMessages["en-CA"].dialog.title,
    activityLogMessages["fr-CA"].dialog.title,
  );
});

test("the clear dialog opens modally on Cancel and gives focus back to whatever opened it", () => {
  class FakeElement {
    isConnected = true;
    focusCount = 0;
    focus() {
      this.focusCount += 1;
    }
  }
  const opened = (opener) => {
    const view = renderClearDialog();
    const modal = {
      showCount: 0,
      closeCount: 0,
      showModal() {
        this.showCount += 1;
      },
      close() {
        this.closeCount += 1;
      },
    };
    const cancelButton = new FakeElement();
    view.dialog.ref.current = modal;
    view.cancel.ref.current = cancelButton;
    assert.equal(view.effects.length, 1, "one effect owns the dialog's lifetime");
    assert.deepEqual(view.effects[0].deps, [], "it opens once per mount, not on every render");
    const cleanup = withGlobals(
      { HTMLElement: FakeElement, document: { body: {}, activeElement: opener } },
      () => view.effects[0].effect(),
    );
    assert.equal(modal.showCount, 1, "opened with showModal() so focus is trapped");
    assert.equal(cancelButton.focusCount, 1, "starts on the safe choice");
    assert.equal(modal.closeCount, 0);
    cleanup();
    assert.equal(modal.closeCount, 1, "closed when it unmounts");
    return { modal, cancelButton };
  };

  const opener = new FakeElement();
  opened(opener);
  assert.equal(opener.focusCount, 1, "focus returns to the Clear button");

  const removed = new FakeElement();
  removed.isConnected = false;
  opened(removed);
  assert.equal(removed.focusCount, 0, "an opener that left the page is left alone");

  opened(null);
  opened({});
});

// ---------------------------------------------------------------------------------------------
// Window root, with the log, the actions and every visual child replaced by doubles: this is
// about how the pieces are wired together.

const ToolbarStub = () => null;
const ListStub = () => null;
const ErrorBannerStub = () => null;
const ClearDialogStub = () => null;

function mountWindow({ locale = "en-CA", log = {}, actions = {} } = {}) {
  const env = installBrowserGlobals();
  const calls = [];
  const titles = [];
  const state = { locale, effectiveVerbose: null, actionInput: null };
  state.log = {
    entries: [],
    historyEntries: [],
    info,
    verbose: false,
    historyEnabled: false,
    historyLoading: false,
    error: null,
    setVerbose: async (enabled) => {
      calls.push(["setVerbose", enabled]);
      return state.effectiveVerbose ?? enabled;
    },
    setHistoryEnabled: (enabled) => calls.push(["setHistoryEnabled", enabled]),
    clear: async () => {
      calls.push(["clear"]);
    },
    ...log,
  };
  state.actions = {
    status: null,
    copy: async () => calls.push(["copy"]),
    openFolder: async () => calls.push(["openFolder"]),
    ...actions,
  };
  const { ActivityLogWindow } = loadModule("src/components/ActivityLog/ActivityLogWindow.tsx", {
    react: hookReact,
    "src/api/activityLog": {
      setActivityLogWindowTitle: async (title) => {
        titles.push(title);
      },
    },
    "src/hooks/useActivityLog": { useActivityLog: () => state.log },
    "src/hooks/useActivityLogActions": {
      useActivityLogActions: (input) => {
        state.actionInput = input;
        return state.actions;
      },
    },
    "src/i18n/index": { useI18n: () => ({ locale: state.locale }) },
    "src/components/ActivityLog/ActivityLogToolbar": { ActivityLogToolbar: ToolbarStub },
    "src/components/ActivityLog/ActivityLogList": { ActivityLogList: ListStub },
    "src/components/ActivityLog/ActivityLogErrorBanner": {
      ActivityLogErrorBanner: ErrorBannerStub,
    },
    "src/components/ActivityLog/ClearLogDialog": { ClearLogDialog: ClearDialogStub },
  });
  const host = mountHook(() => ActivityLogWindow(), {});
  const find = (type) => findAll(host.result, (node) => node.type === type)[0];
  return {
    host,
    state,
    calls,
    titles,
    toolbar: () => find(ToolbarStub).props,
    list: () => find(ListStub).props,
    banner: () => find(ErrorBannerStub),
    dialog: () => find(ClearDialogStub),
    footer: () => find("footer"),
    dispose() {
      host.unmount();
      env.restore();
    },
  };
}

async function withWindow(options, body) {
  const view = mountWindow(options);
  try {
    await body(view);
  } finally {
    view.dispose();
  }
}

test("the window is titled in the app language, on the page and on the native window", async () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    await withWindow({ locale }, async (view) => {
      const title = activityLogMessages[locale].windowTitle;
      assert.equal(globalThis.document.title, title);
      assert.deepEqual(view.titles, [title]);
    });
  }
});

test("the title is only set again when the language changes", async () => {
  await withWindow({}, async (view) => {
    view.host.setProps({});
    view.host.setProps({});
    assert.equal(view.titles.length, 1, "re-rendering for new entries leaves the window alone");
    view.state.locale = "fr-CA";
    view.host.setProps({});
    assert.deepEqual(view.titles, ["Activity Log", "Journal d\u2019activit\u00e9"]);
    assert.equal(globalThis.document.title, "Journal d\u2019activit\u00e9");
  });
});

test("the window fills its frame: toolbar on top, list in the middle, privacy note at the bottom", async () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    await withWindow({ locale }, async (view) => {
      const root = view.host.result;
      assert.match(root.props.className, /\bh-screen\b/);
      assert.match(root.props.className, /\bflex-col\b/);
      assert.deepEqual(
        root.props.children.filter(Boolean).map((child) => child.type),
        [ToolbarStub, ListStub, "footer"],
      );
      assert.equal(textOf(view.footer()), activityLogMessages[locale].footerNote);
    });
  }
});

test("turning Verbose on also reveals debug entries, but only once the backend agreed", async () => {
  await withWindow({}, async (view) => {
    assert.equal(view.toolbar().filters.levels.has("debug"), false, "debug starts hidden");
    view.toolbar().onVerboseChange(true);
    await settle();
    assert.deepEqual(view.calls, [["setVerbose", true]]);
    assert.equal(view.toolbar().filters.levels.has("debug"), true);
  });

  await withWindow({}, async (view) => {
    view.state.effectiveVerbose = false;
    view.toolbar().onVerboseChange(true);
    await settle();
    assert.deepEqual(view.calls, [["setVerbose", true]]);
    assert.equal(view.toolbar().filters.levels.has("debug"), false, "the backend refused");
  });
});

test("turning Verbose off never hides what the user chose to see", async () => {
  await withWindow({ log: { verbose: true } }, async (view) => {
    view.toolbar().onFiltersChange(filter.setLevelEnabled(view.toolbar().filters, "debug", true));
    await settle();
    view.toolbar().onVerboseChange(false);
    await settle();
    assert.deepEqual(view.calls, [["setVerbose", false]]);
    assert.equal(view.toolbar().filters.levels.has("debug"), true);
  });
});

test("the toggles reflect the log and drive it", async () => {
  await withWindow(
    { log: { verbose: true, historyEnabled: true, historyLoading: true } },
    async (view) => {
      const toolbar = view.toolbar();
      assert.equal(toolbar.verbose, true);
      assert.equal(toolbar.historyEnabled, true);
      assert.equal(toolbar.historyLoading, true);
      toolbar.onHistoryChange(false);
      toolbar.onHistoryChange(true);
      assert.deepEqual(view.calls, [
        ["setHistoryEnabled", false],
        ["setHistoryEnabled", true],
      ]);
    },
  );
});

test("Clear asks first: Cancel clears nothing, Clear wipes the log and closes the dialog", async () => {
  await withWindow({}, async (view) => {
    assert.equal(view.dialog(), undefined, "no dialog until asked");
    view.toolbar().onClear();
    await settle();
    assert.equal(view.dialog().props.busy, false);
    assert.equal(view.dialog().props.error, null);

    view.dialog().props.onClose();
    await settle();
    assert.equal(view.dialog(), undefined);
    assert.deepEqual(view.calls, [], "cancelling cleared nothing");

    view.toolbar().onClear();
    await settle();
    view.dialog().props.onConfirm();
    await settle();
    assert.deepEqual(view.calls, [["clear"]]);
    assert.equal(view.dialog(), undefined, "closed after a successful clear");
  });
});

test("a clear in progress cannot be dismissed, and a failure stays on screen in the app language", async () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    const gate = deferred();
    await withWindow({ locale, log: { clear: () => gate.promise } }, async (view) => {
      view.toolbar().onClear();
      await settle();
      view.dialog().props.onConfirm();
      await settle();
      assert.equal(view.dialog().props.busy, true);

      view.dialog().props.onClose();
      await settle();
      assert.ok(view.dialog(), "Cancel is ignored while the log is being wiped");

      gate.reject("disk is full");
      await settle();
      assert.equal(view.dialog().props.busy, false);
      assert.equal(
        view.dialog().props.error,
        activityLogMessages[locale].dialog.failed("disk is full"),
      );
      view.dialog().props.onClose();
      await settle();
      assert.equal(view.dialog(), undefined, "the user can still back out");
    });
  }
});

test("Copy and Open log folder are only offered when there is something to act on", async () => {
  const offered = async (log) => {
    let result;
    await withWindow({ log }, async (view) => {
      result = { copy: view.toolbar().canCopy, folder: view.toolbar().canOpenFolder };
    });
    return result;
  };
  assert.deepEqual(await offered({ info: null }), { copy: false, folder: false });
  assert.deepEqual(await offered({ entries: rowsOf(2), info: { ...info, logDir: "" } }), {
    copy: true,
    folder: false,
  });
  assert.deepEqual(await offered({ entries: rowsOf(2) }), { copy: true, folder: true });
  assert.deepEqual(await offered({ entries: rowsOf(2, { level: "debug" }) }), {
    copy: false,
    folder: true,
  });
});

test("Copy and Open log folder run the log actions, fed with exactly what the filters show", async () => {
  const status = { kind: "copied", count: 2 };
  await withWindow({ log: { entries: rowsOf(3) }, actions: { status } }, async (view) => {
    view.toolbar().onCopy();
    view.toolbar().onOpenFolder();
    await settle();
    assert.deepEqual(view.calls, [["copy"], ["openFolder"]]);
    assert.equal(view.toolbar().status, status);

    view.toolbar().onFiltersChange({ ...view.toolbar().filters, search: "row 1" });
    await settle();
    const input = view.state.actionInput;
    assert.deepEqual(
      input.visibleRows.map((row) => row.message),
      ["row 1"],
    );
    assert.equal(input.totalCount, 3, "the header can say 1 of 3");
    assert.equal(input.info, info);
    assert.equal(input.filters, view.toolbar().filters);
  });
});

test("the counters compare what is shown with everything the window holds", async () => {
  const current = [
    buffer.toCurrentRow(entry({ id: 1, level: "info", category: "sync" })),
    buffer.toCurrentRow(entry({ id: 2, level: "warn", category: "api" })),
    buffer.toCurrentRow(entry({ id: 3, level: "debug", category: "sync" })),
  ];
  const earlier = buffer.toHistoryRows([
    entry({ id: 1, level: "error", category: "db" }),
    entry({ id: 2, level: "info", category: "sync" }),
  ]);
  await withWindow({ log: { entries: current, historyEntries: earlier } }, async (view) => {
    assert.equal(view.toolbar().shownCount, 2, "debug is hidden by default");
    assert.equal(view.toolbar().totalCount, 3);
    assert.equal(view.list().totalCount, 3);
    assert.deepEqual(view.toolbar().levelCounts, { error: 0, warn: 1, info: 1, debug: 1 });
    assert.deepEqual(view.toolbar().categories, ["api", "sync"]);

    view.state.log = { ...view.state.log, historyEnabled: true };
    view.host.setProps({});
    assert.equal(view.toolbar().shownCount, 4);
    assert.equal(view.toolbar().totalCount, 5);
    assert.deepEqual(view.toolbar().levelCounts, { error: 1, warn: 1, info: 2, debug: 1 });
    assert.deepEqual(view.toolbar().categories, ["api", "db", "sync"]);
  });
});

test("Reset filters brings every filter back to its default", async () => {
  await withWindow({ log: { entries: rowsOf(3) } }, async (view) => {
    view.toolbar().onFiltersChange({
      ...view.toolbar().filters,
      search: "no such text",
      slowOnly: true,
      range: "5m",
    });
    await settle();
    assert.equal(view.list().items.length, 0, "everything is filtered out");
    assert.equal(view.list().totalCount, 3, "which the list tells apart from an empty log");

    view.list().onResetFilters();
    await settle();
    assert.deepEqual(view.toolbar().filters, DEFAULT_FILTERS);
    assert.equal(view.list().items.filter((item) => item.kind === "entry").length, 3);
  });
});

test("a log failure is shown above the list and goes away once it clears", async () => {
  const error = { kind: "poll", message: "backend unreachable" };
  await withWindow({ log: { error } }, async (view) => {
    assert.equal(view.banner().props.error, error);
    view.state.log = { ...view.state.log, error: null };
    view.host.setProps({});
    assert.equal(view.banner(), undefined);
  });
  await withWindow({}, async (view) => {
    assert.equal(view.banner(), undefined, "no banner while all is well");
  });
});

test("the list follows the newest entry again when the filters change, not on every poll", async () => {
  await withWindow({ log: { entries: rowsOf(2) } }, async (view) => {
    const first = view.list().resetKey;
    assert.equal(first, view.toolbar().filters);

    view.state.log = { ...view.state.log, entries: rowsOf(5) };
    view.host.setProps({});
    assert.equal(view.list().items.filter((item) => item.kind === "entry").length, 5);
    assert.equal(view.list().resetKey, first, "new entries leave a paused list paused");

    view.toolbar().onFiltersChange({ ...view.toolbar().filters, slowOnly: true });
    await settle();
    assert.notEqual(view.list().resetKey, first);
  });
});

// ---------------------------------------------------------------------------------------------
// Toolbar parts, called as plain functions so the props they hand to the DOM can be read

let leafLocale = "en-CA";
const leafDoubles = {
  react: { ...React, useId: () => "hint-id" },
  "src/i18n/index": { useI18n: () => ({ locale: leafLocale }) },
};
const loadComponent = (name, doubles = leafDoubles) =>
  loadModule(`src/components/ActivityLog/${name}.tsx`, doubles)[name];
const ActivityLogFilters = loadComponent("ActivityLogFilters");
const ActivityLevelChips = loadComponent("ActivityLevelChips");
const ActivityLogToggles = loadComponent("ActivityLogToggles");
const ActivityLogActionBar = loadComponent("ActivityLogActionBar");
const ActivityLogEmptyState = loadComponent("ActivityLogEmptyState");
const ActivityLogErrorBanner = loadComponent("ActivityLogErrorBanner");

const inLocale = (locale, body) => {
  leafLocale = locale;
  try {
    return body(activityLogMessages[locale]);
  } finally {
    leafLocale = "en-CA";
  }
};
const withAriaLabel = (tree, label) => findAll(tree, (node) => node.props["aria-label"] === label);
const buttonsOf = (tree) => findAll(tree, (node) => node.type === "button");

test("the filter controls are labelled in the app language and each change keeps the others", () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    inLocale(locale, (labels) => {
      const changes = [];
      const filters = filtersWith({ category: "sync", range: "5m", search: "retry" });
      const tree = ActivityLogFilters({
        filters,
        categories: ["api", "sync"],
        onChange: (next) => changes.push(next),
      });
      const [category] = withAriaLabel(tree, labels.category);
      const [range] = withAriaLabel(tree, labels.range);
      const [search] = withAriaLabel(tree, labels.search);
      const [slowOnly] = findAll(tree, (node) => node.props.type === "checkbox");

      assert.equal(category.type, "select");
      assert.equal(category.props.value, "sync");
      assert.deepEqual(
        findAll(category, (node) => node.type === "option").map((option) => textOf(option)),
        [labels.allCategories, "api", "sync"],
      );
      assert.equal(range.props.value, "5m");
      assert.deepEqual(
        findAll(range, (node) => node.type === "option").map((option) => option.props.value),
        filter.TIME_RANGES,
      );
      assert.deepEqual(
        findAll(range, (node) => node.type === "option").map((option) => textOf(option)),
        filter.TIME_RANGES.map((value) => labels.ranges[value]),
      );
      assert.equal(search.props.value, "retry");
      assert.equal(search.props.placeholder, labels.searchPlaceholder);
      assert.equal(slowOnly.props.checked, false);
      assert.ok(textOf(tree).includes(labels.slowOnly));

      category.props.onChange({ target: { value: "api" } });
      range.props.onChange({ target: { value: "15m" } });
      range.props.onChange({ target: { value: "not-a-range" } });
      search.props.onChange({ target: { value: "timeout" } });
      slowOnly.props.onChange({ target: { checked: true } });
      assert.deepEqual(changes, [
        { ...filters, category: "api" },
        { ...filters, range: "15m" },
        { ...filters, search: "timeout" },
        { ...filters, slowOnly: true },
      ]);
    });
  }
});

test("Escape in the search box clears the text, but only when there is text to clear", () => {
  const labels = activityLogMessages["en-CA"];
  const press = (search) => {
    const changes = [];
    let prevented = 0;
    const filters = filtersWith({ search });
    const tree = ActivityLogFilters({
      filters,
      categories: [],
      onChange: (next) => changes.push(next),
    });
    const [input] = withAriaLabel(tree, labels.search);
    input.props.onKeyDown({ key: "a", preventDefault: () => (prevented += 1) });
    input.props.onKeyDown({ key: "Escape", preventDefault: () => (prevented += 1) });
    const clearButtons = withAriaLabel(tree, labels.clearSearch);
    for (const button of clearButtons) button.props.onClick();
    return { changes, prevented, clearButtons: clearButtons.length };
  };

  const typed = press("abc");
  assert.equal(typed.prevented, 1, "only Escape is intercepted");
  assert.equal(typed.clearButtons, 1, "a clear button is offered next to the text");
  assert.deepEqual(
    typed.changes.map((next) => next.search),
    ["", ""],
    "Escape and the button both empty the box",
  );

  const empty = press("");
  assert.equal(empty.prevented, 0, "Escape is left alone when nothing is typed");
  assert.equal(empty.clearButtons, 0);
  assert.deepEqual(empty.changes, []);
});

test("level chips show how many entries each level holds and toggle on click", () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    inLocale(locale, (labels) => {
      const toggled = [];
      const tree = ActivityLevelChips({
        levels: new Set(["error", "warn", "info"]),
        counts: { error: 2, warn: 0, info: 1234, debug: 7 },
        onToggle: (level) => toggled.push(level),
      });
      assert.equal(tree.props.role, "group");
      assert.equal(tree.props["aria-label"], labels.levelGroup);
      const chips = buttonsOf(tree);
      assert.deepEqual(
        chips.map((chip) => chip.props["aria-pressed"]),
        [true, true, true, false],
        "debug is off until asked for",
      );
      assert.deepEqual(chips.map(textOf), [
        `${labels.levelNames.error}2`,
        `${labels.levelNames.warn}0`,
        `${labels.levelNames.info}${labels.formatNumber(1234)}`,
        `${labels.levelNames.debug}7`,
      ]);
      chips[3].props.onClick();
      chips[0].props.onClick();
      assert.deepEqual(toggled, ["debug", "error"]);
    });
  }
});

test("the Previous sessions and Verbose switches report their state, and Verbose explains itself", () => {
  const labels = activityLogMessages["en-CA"];
  const events = [];
  const render = (overrides = {}) =>
    ActivityLogToggles({
      historyEnabled: false,
      historyLoading: false,
      onHistoryChange: (value) => events.push(["history", value]),
      verbose: true,
      onVerboseChange: (value) => events.push(["verbose", value]),
      ...overrides,
    });
  const tree = render();
  const [history, verbose] = findAll(tree, (node) => node.props.type === "checkbox");
  assert.equal(history.props.checked, false);
  assert.equal(verbose.props.checked, true);
  history.props.onChange({ target: { checked: true } });
  verbose.props.onChange({ target: { checked: false } });
  assert.deepEqual(events, [
    ["history", true],
    ["verbose", false],
  ]);
  assert.ok(textOf(tree).includes(labels.previousSessions));
  assert.ok(textOf(tree).includes(labels.verbose));
  const [hint] = findAll(tree, (node) => node.props.id === verbose.props["aria-describedby"]);
  assert.equal(textOf(hint), labels.verboseHint);

  assert.deepEqual(withAriaLabel(tree, labels.previousSessionsLoading), [], "idle: no spinner");
  const [spinner] = withAriaLabel(render({ historyLoading: true }), labels.previousSessionsLoading);
  assert.equal(spinner.props.role, "status");
});

test("the action bar counts entries, reports results in a polite live region and disables what cannot work", () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    inLocale(locale, (labels) => {
      const calls = [];
      const render = (overrides = {}) =>
        ActivityLogActionBar({
          shownCount: 3,
          totalCount: 5,
          status: null,
          canCopy: true,
          canOpenFolder: true,
          onCopy: () => calls.push("copy"),
          onClear: () => calls.push("clear"),
          onOpenFolder: () => calls.push("open"),
          ...overrides,
        });
      const byLabel = (tree, text) => buttonsOf(tree).find((button) => textOf(button) === text);
      const statusOf = (tree) => findAll(tree, (node) => node.props.role === "status")[0];

      const idle = render();
      assert.ok(textOf(idle).includes(labels.counter(3, 5)));
      assert.equal(statusOf(idle).props["aria-live"], "polite");
      assert.equal(textOf(statusOf(idle)), "", "the live region exists before it has news");
      byLabel(idle, labels.copy).props.onClick();
      byLabel(idle, labels.openLogFolder).props.onClick();
      byLabel(idle, labels.clear).props.onClick();
      assert.deepEqual(calls, ["copy", "open", "clear"]);

      const blocked = render({ canCopy: false, canOpenFolder: false });
      assert.equal(byLabel(blocked, labels.copy).props.disabled, true);
      assert.equal(byLabel(blocked, labels.openLogFolder).props.disabled, true);
      assert.equal(
        byLabel(blocked, labels.clear).props.disabled,
        undefined,
        "Clear is always there",
      );
      assert.equal(byLabel(idle, labels.copy).props.disabled, false);

      for (const [status, expected] of [
        [{ kind: "copied", count: 1 }, labels.copied(1)],
        [{ kind: "copied", count: 1500 }, labels.copied(1500)],
        [{ kind: "copy-failed" }, labels.copyFailed],
        [{ kind: "open-failed" }, labels.openLogFolderFailed],
      ]) {
        assert.equal(textOf(statusOf(render({ status }))), expected);
      }
    });
  }
  assert.equal(activityLogMessages["en-CA"].copied(1), "Copied 1 line");
  assert.equal(activityLogMessages["en-CA"].copied(1500), "Copied 1,500 lines");
});

test("the empty states tell an empty log from filters that hide everything", () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    inLocale(locale, (labels) => {
      let resets = 0;
      const empty = ActivityLogEmptyState({
        variant: "empty",
        onResetFilters: () => (resets += 1),
      });
      assert.ok(textOf(empty).includes(labels.emptyTitle));
      assert.ok(textOf(empty).includes(labels.emptyBody));
      assert.deepEqual(buttonsOf(empty), [], "nothing to reset when nothing was logged");

      const noMatch = ActivityLogEmptyState({
        variant: "no-match",
        onResetFilters: () => (resets += 1),
      });
      assert.ok(textOf(noMatch).includes(labels.noMatchTitle));
      assert.ok(textOf(noMatch).includes(labels.noMatchBody));
      const [reset] = buttonsOf(noMatch);
      assert.equal(textOf(reset), labels.resetFilters);
      reset.props.onClick();
      assert.equal(resets, 1);
    });
  }
});

test("the error banner is an alert that says what failed and why, in the app language", () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    inLocale(locale, (labels) => {
      for (const kind of ["poll", "history", "verbose"]) {
        const banner = ActivityLogErrorBanner({ error: { kind, message: "backend unreachable" } });
        assert.equal(banner.props.role, "alert");
        assert.equal(textOf(banner), labels.errors[kind]("backend unreachable"));
        assert.ok(textOf(banner).includes("backend unreachable"));
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Server-rendered markup: the real components on real React and the real list virtualiser. A
// warning React raises while rendering (keys, invalid nesting, controlled inputs) fails the test.

let ssrLocale = "en-CA";
const ssrState = { log: null };
const ssrDoubles = {
  // The list pins itself to the newest entry in a layout effect, which means nothing on a server.
  react: { ...React, useLayoutEffect: React.useEffect },
  "src/i18n/index": { useI18n: () => ({ locale: ssrLocale }) },
};
const loadSsr = (name, extraDoubles = {}) =>
  loadModule(`src/components/ActivityLog/${name}.tsx`, { ...ssrDoubles, ...extraDoubles })[name];

// Loaded while no `document` exists, which is how the virtualiser picks its effect flavour.
const SsrRow = loadSsr("ActivityLogRow");
const SsrDivider = loadSsr("ActivityLogDivider");
const SsrList = loadSsr("ActivityLogList");
const SsrToolbar = loadSsr("ActivityLogToolbar");
const SsrWindow = loadSsr("ActivityLogWindow", {
  "src/api/activityLog": {
    setActivityLogWindowTitle: async () => {},
    copyTextToClipboard: async () => {},
    openLogFolder: async () => {},
  },
  "src/hooks/useActivityLog": { useActivityLog: () => ssrState.log },
});
const pausedJumps = [];
const SsrPausedList = loadSsr("ActivityLogVirtualList", {
  "src/hooks/useFollowLatest": {
    useFollowLatest: () => ({
      following: false,
      pausedAtKey: ssrState.pausedAtKey,
      onScroll: () => {},
      jumpToLatest: () => pausedJumps.push("jump"),
    }),
  },
});

const escapeHtml = (text) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const stripTags = (html) => html.replace(/<[^>]*>/g, "");
const buttonsIn = (markup) => markup.match(/<button\b.*?<\/button>/gs) ?? [];
const buttonLabelled = (markup, text) =>
  buttonsIn(markup).find((button) => stripTags(button).trim() === escapeHtml(text));
const occurrences = (markup, needle) => markup.split(needle).length - 1;
const renderedIndexes = (markup) =>
  [...markup.matchAll(/data-index="(\d+)"/g)].map((match) => Number(match[1]));
const rowOf = (overrides) => buffer.toCurrentRow(entry(overrides));
const noop = () => {};

function renderMarkup(type, props, locale = "en-CA") {
  ssrLocale = locale;
  const logs = captureConsole();
  try {
    const markup = renderToStaticMarkup(React.createElement(type, props));
    assert.deepEqual(logs.error, [], "React raised no warning while rendering");
    return markup;
  } finally {
    logs.restore();
    ssrLocale = "en-CA";
  }
}

test("a row shows time, level, origin and message as selectable text that is never parsed as HTML", () => {
  const row = rowOf({
    level: "error",
    source: "rust",
    category: "api",
    timestampMs: local(17, 14, 2, 11, 482),
    message: "GET /albums failed\n  caused by <img src=x onerror=alert(1)> & more",
    durationMs: 1234,
    slow: true,
  });
  for (const locale of ["en-CA", "fr-CA"]) {
    const labels = activityLogMessages[locale];
    const markup = renderMarkup(SsrRow, { row }, locale);
    assert.ok(markup.includes('data-level="error"'));
    assert.ok(markup.includes(format.formatEntryTime(row.timestampMs)));
    assert.ok(markup.includes(">error</span>"));
    assert.ok(markup.includes("rust/api"));
    assert.ok(markup.includes("select-text"), "selectable although the app disables selection");
    assert.ok(markup.includes("whitespace-pre-wrap"), "line breaks of stack traces survive");
    assert.ok(
      markup.includes(
        "GET /albums failed\n  caused by &lt;img src=x onerror=alert(1)&gt; &amp; more",
      ),
    );
    assert.ok(!markup.includes("<img"), "message text is escaped, not injected");
    assert.ok(markup.includes(format.formatDuration(1234)));
    assert.ok(markup.includes(`>${labels.slowBadge}</span>`));
    assert.ok(markup.includes(`title="${escapeHtml(labels.slowBadgeTitle("1.2 s"))}"`));
  }
});

test("only slow entries carry the SLOW badge; a duration alone is just shown", () => {
  const plain = renderMarkup(SsrRow, { row: rowOf({ message: "plain" }) });
  const timed = renderMarkup(SsrRow, { row: rowOf({ message: "timed", durationMs: 42 }) });
  const slow = renderMarkup(SsrRow, { row: rowOf({ durationMs: 42, slow: true }) });
  const slowOnly = renderMarkup(SsrRow, { row: rowOf({ slow: true }) });
  assert.ok(!plain.includes("SLOW") && !plain.includes(" ms"));
  assert.ok(timed.includes("42 ms") && !timed.includes("SLOW"));
  assert.ok(slow.includes("42 ms") && slow.includes(">SLOW</span>"));
  assert.ok(slowOnly.includes(">SLOW</span>"));
});

test("errors and warnings stand out, and older sessions are tinted only when they are routine", () => {
  const [oldInfo] = buffer.toHistoryRows([entry({ level: "info" })]);
  const [oldDebug] = buffer.toHistoryRows([entry({ level: "debug" })]);
  const [oldError] = buffer.toHistoryRows([entry({ level: "error" })]);
  const tinted = (row) => renderMarkup(SsrRow, { row }).includes("bg-base-200/60");
  assert.equal(tinted(oldInfo), true);
  assert.equal(tinted(oldDebug), true);
  assert.equal(tinted(oldError), false, "a past error keeps its alarming colour");
  assert.equal(tinted(rowOf({ level: "info" })), false);

  const styled = (level) => renderMarkup(SsrRow, { row: rowOf({ level }) });
  assert.ok(styled("error").includes("border-error"));
  assert.ok(styled("warn").includes("border-warning"));
  assert.ok(!styled("info").includes("border-error") && !styled("info").includes("border-warning"));
  assert.ok(styled("debug").includes('data-level="debug"'));
});

test("dividers name the day or the app session, and flag a session that ended abruptly", () => {
  const timestampMs = local(17, 14, 2, 11, 482);
  const marker = rowOf({
    category: "session",
    timestampMs,
    message: "session started \u00b7 app v1.2.3 \u00b7 macOS aarch64 \u00b7 pid 4242",
  });
  const session = (unexpectedEnd) => ({
    kind: "session",
    key: marker.rowKey,
    row: marker,
    unexpectedEnd,
  });
  assert.notEqual(
    format.formatDateLabel(timestampMs, "en-CA"),
    format.formatDateLabel(timestampMs, "fr-CA"),
  );

  for (const locale of ["en-CA", "fr-CA"]) {
    const labels = activityLogMessages[locale];
    const day = renderMarkup(
      SsrDivider,
      { item: { kind: "date", key: "date-1", timestampMs } },
      locale,
    );
    assert.ok(day.includes('class="divider'));
    assert.ok(day.includes(escapeHtml(format.formatDateLabel(timestampMs, locale))));

    const calm = renderMarkup(SsrDivider, { item: session(false) }, locale);
    assert.ok(calm.includes(escapeHtml(marker.message)));
    assert.ok(!calm.includes(escapeHtml(labels.unexpectedEnd)));

    const abrupt = renderMarkup(SsrDivider, { item: session(true) }, locale);
    assert.ok(abrupt.includes(escapeHtml(marker.message)));
    assert.ok(abrupt.includes(escapeHtml(labels.unexpectedEnd)));
    assert.ok(abrupt.includes('aria-hidden="true"'), "the warning icon is decorative");
  }
});

test("the list tells an empty log from filters that hide everything", () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    const labels = activityLogMessages[locale];
    const props = { items: [], resetKey: null, onResetFilters: noop };
    const empty = renderMarkup(SsrList, { ...props, totalCount: 0 }, locale);
    const hidden = renderMarkup(SsrList, { ...props, totalCount: 7 }, locale);
    assert.ok(empty.includes(escapeHtml(labels.emptyTitle)));
    assert.ok(!empty.includes(escapeHtml(labels.noMatchTitle)));
    assert.equal(buttonLabelled(empty, labels.resetFilters), undefined, "nothing to reset");
    assert.ok(hidden.includes(escapeHtml(labels.noMatchTitle)));
    assert.ok(!hidden.includes(escapeHtml(labels.emptyTitle)));
    assert.ok(buttonLabelled(hidden, labels.resetFilters));
    assert.ok(!empty.includes('role="log"') && !hidden.includes('role="log"'));
  }
});

test("the list renders its rows in a labelled, focusable log region that opens with the day", () => {
  const rows = [
    rowOf({ level: "error", message: "upload failed" }),
    rowOf({ level: "warn", message: "retrying in 2 s" }),
    rowOf({ level: "info", message: "sync finished" }),
  ];
  const items = listItems.buildListItems(rows, new Set());
  for (const locale of ["en-CA", "fr-CA"]) {
    const labels = activityLogMessages[locale];
    const markup = renderMarkup(
      SsrList,
      { items, totalCount: rows.length, resetKey: null, onResetFilters: noop },
      locale,
    );
    assert.ok(markup.includes('role="log"'));
    assert.ok(markup.includes(`aria-label="${escapeHtml(labels.listLabel)}"`));
    assert.ok(markup.includes('tabindex="0"'), "keyboard users can focus and scroll the list");
    assert.deepEqual(renderedIndexes(markup), [0, 1, 2, 3], "the day divider, then each entry");
    for (const row of rows) assert.ok(markup.includes(row.message));
    assert.ok(markup.indexOf("upload failed") < markup.indexOf("sync finished"));
    assert.ok(markup.includes(escapeHtml(format.formatDateLabel(rows[0].timestampMs, locale))));
    assert.ok(!markup.includes(escapeHtml(labels.jumpToLatest)), "already on the newest entry");
  }
});

test("ten thousand entries render only the rows near the viewport", () => {
  const rows = Array.from({ length: 10_000 }, (_, index) =>
    rowOf({ id: index + 1, message: `bulk row ${index + 1}` }),
  );
  const items = listItems.buildListItems(rows, new Set());
  const markup = renderMarkup(SsrList, {
    items,
    totalCount: rows.length,
    resetKey: null,
    onResetFilters: noop,
  });
  const indexes = renderedIndexes(markup);
  assert.ok(indexes.length >= 20 && indexes.length <= 80, `rendered ${indexes.length} rows`);
  assert.deepEqual(
    indexes,
    indexes.map((_, position) => position),
    "one contiguous window from the top",
  );
  const totalHeight = items.reduce((sum, item) => sum + listItems.estimateItemHeight(item), 0);
  assert.ok(markup.includes(`height:${totalHeight}px`), "the scroll height covers every entry");
  assert.ok(markup.includes("bulk row 1<") && !markup.includes("bulk row 10000"));
});

test("a list that stopped following offers a way back to the newest entry and counts what arrived", () => {
  const rows = [1, 2, 3, 4].map((number) => rowOf({ id: number, message: `entry ${number}` }));
  const items = listItems.buildListItems(rows, new Set());
  const render = (pausedAtKey, locale = "en-CA") => {
    ssrState.pausedAtKey = pausedAtKey;
    return renderMarkup(SsrPausedList, { items, resetKey: null }, locale);
  };

  for (const locale of ["en-CA", "fr-CA"]) {
    const labels = activityLogMessages[locale];
    const behind = render("c-2", locale);
    const button = buttonLabelled(behind, `${labels.jumpToLatest}\u00b7 ${labels.newEntries(2)}`);
    assert.ok(button, "the button also says how many entries are waiting below");

    const atEnd = render("c-4", locale);
    assert.ok(buttonLabelled(atEnd, labels.jumpToLatest), "nothing new: no counter");
    const gone = render("c-999", locale);
    assert.ok(buttonLabelled(gone, labels.jumpToLatest), "an unknown position: no counter");
    assert.ok(!gone.includes(escapeHtml(labels.newEntries(0))));
  }
});

test("the toolbar offers every control with an accessible name, in both languages", () => {
  const props = {
    filters: DEFAULT_FILTERS,
    onFiltersChange: noop,
    levelCounts: { error: 1, warn: 2, info: 3, debug: 4 },
    categories: ["api", "sync"],
    historyEnabled: false,
    historyLoading: false,
    onHistoryChange: noop,
    verbose: false,
    onVerboseChange: noop,
    shownCount: 6,
    totalCount: 10,
    status: null,
    canCopy: true,
    canOpenFolder: true,
    onCopy: noop,
    onClear: noop,
    onOpenFolder: noop,
  };
  for (const locale of ["en-CA", "fr-CA"]) {
    const labels = activityLogMessages[locale];
    const markup = renderMarkup(SsrToolbar, props, locale);
    const text = stripTags(markup);
    for (const name of [labels.levelGroup, labels.category, labels.search, labels.range]) {
      assert.ok(markup.includes(`aria-label="${escapeHtml(name)}"`), `${name} is labelled`);
    }
    for (const shown of [
      labels.slowOnly,
      labels.previousSessions,
      labels.verbose,
      labels.verboseHint,
      labels.counter(6, 10),
      labels.allCategories,
      ...Object.values(labels.ranges),
    ]) {
      assert.ok(text.includes(escapeHtml(shown)), `${shown} is shown`);
    }
    for (const name of [labels.copy, labels.openLogFolder, labels.clear]) {
      assert.ok(buttonLabelled(markup, name), `${name} is a button`);
    }
    const chips = buttonsIn(markup).filter((button) => button.includes("aria-pressed"));
    assert.deepEqual(chips.map(stripTags), [
      `${labels.levelNames.error}1`,
      `${labels.levelNames.warn}2`,
      `${labels.levelNames.info}3`,
      `${labels.levelNames.debug}4`,
    ]);
    assert.deepEqual(
      chips.map((chip) => /aria-pressed="(\w+)"/.exec(chip)[1]),
      ["true", "true", "true", "false"],
      "debug is off by default",
    );
    assert.doesNotMatch(buttonLabelled(markup, labels.copy), /\bdisabled/);
    assert.doesNotMatch(buttonLabelled(markup, labels.openLogFolder), /\bdisabled/);
    assert.equal(occurrences(markup, 'checked=""'), 0, "every switch starts off");

    const switchedOn = renderMarkup(
      SsrToolbar,
      { ...props, historyEnabled: true, verbose: true },
      locale,
    );
    assert.equal(occurrences(switchedOn, 'checked=""'), 2, "previous sessions and verbose");

    const blocked = renderMarkup(
      SsrToolbar,
      { ...props, canCopy: false, canOpenFolder: false, shownCount: 0 },
      locale,
    );
    assert.match(buttonLabelled(blocked, labels.copy), /\bdisabled=""/);
    assert.match(buttonLabelled(blocked, labels.openLogFolder), /\bdisabled=""/);
    assert.doesNotMatch(buttonLabelled(blocked, labels.clear), /\bdisabled/);
  }
});

function windowLog(overrides = {}) {
  return {
    entries: [],
    historyEntries: [],
    info,
    verbose: false,
    setVerbose: async () => false,
    clear: async () => {},
    historyEnabled: false,
    setHistoryEnabled: noop,
    historyLoading: false,
    error: null,
    ...overrides,
  };
}

function renderWindow(log, locale = "en-CA") {
  ssrState.log = log;
  try {
    return renderMarkup(SsrWindow, {}, locale);
  } finally {
    ssrState.log = null;
  }
}

test("the window shows the filtered log, how much it hides, and a note about names in logs", () => {
  const rows = [
    rowOf({
      level: "debug",
      category: "cache",
      message: "cache warmed",
      timestampMs: local(17, 14, 1, 40),
    }),
    rowOf({
      level: "info",
      category: "sync",
      message: "sync started",
      timestampMs: local(17, 14, 2, 0),
    }),
    rowOf({
      level: "warn",
      category: "api",
      message: "GET /albums is slow",
      timestampMs: local(17, 14, 2, 30),
      durationMs: 2500,
      slow: true,
    }),
    rowOf({
      level: "error",
      category: "sync",
      message: "upload failed: <b>IMG_0001.jpg</b>",
      timestampMs: local(17, 14, 3, 0),
    }),
  ];
  for (const locale of ["en-CA", "fr-CA"]) {
    const labels = activityLogMessages[locale];
    const markup = renderWindow(windowLog({ entries: rows }), locale);
    const text = stripTags(markup);

    assert.ok(markup.includes("h-screen"), "fills the window");
    assert.ok(markup.includes("<footer"));
    assert.ok(text.includes(escapeHtml(labels.footerNote)));
    assert.ok(text.includes(escapeHtml(labels.counter(3, 4))), "debug is hidden but counted");
    assert.deepEqual(
      [...markup.matchAll(/data-level="(\w+)"/g)].map((match) => match[1]),
      ["info", "warn", "error"],
      "oldest first, without debug",
    );
    assert.ok(!markup.includes("cache warmed"));
    assert.equal(occurrences(markup, `>${labels.slowBadge}</span>`), 1);
    assert.ok(markup.includes("upload failed: &lt;b&gt;IMG_0001.jpg&lt;/b&gt;"));
    assert.ok(markup.includes(escapeHtml(format.formatDateLabel(rows[0].timestampMs, locale))));
    assert.ok(markup.includes('role="log"'));
    assert.ok(!markup.includes('role="alert"'), "no banner while the log reads fine");
    assert.ok(!markup.includes("<dialog"), "the clear confirmation stays closed until asked for");
    assert.deepEqual(
      ["api", "cache", "sync"].filter((category) => markup.includes(`>${category}</option>`)),
      ["api", "cache", "sync"],
      "the category list comes from the entries",
    );
  }
});

test("the window reports an unreadable log, an empty log and a log folder it cannot open", () => {
  for (const locale of ["en-CA", "fr-CA"]) {
    const labels = activityLogMessages[locale];
    const broken = renderWindow(
      windowLog({ error: { kind: "poll", message: "backend unreachable" }, info: null }),
      locale,
    );
    assert.ok(broken.includes('role="alert"'));
    assert.ok(stripTags(broken).includes(escapeHtml(labels.errors.poll("backend unreachable"))));
    assert.match(buttonLabelled(broken, labels.openLogFolder), /\bdisabled=""/);

    const empty = renderWindow(windowLog(), locale);
    assert.ok(stripTags(empty).includes(escapeHtml(labels.emptyTitle)));
    assert.ok(stripTags(empty).includes(escapeHtml(labels.counter(0, 0))));
    assert.match(buttonLabelled(empty, labels.copy), /\bdisabled=""/);
    assert.doesNotMatch(buttonLabelled(empty, labels.openLogFolder), /\bdisabled/);
    assert.ok(!empty.includes('role="log"'));
  }
});

test("previous sessions are listed first, and a session that never ended is flagged on the next", () => {
  const labels = activityLogMessages["en-CA"];
  const history = buffer.toHistoryRows([
    entry({
      category: "session",
      message: "session started \u00b7 app v1.2.2 \u00b7 macOS aarch64 \u00b7 pid 100",
      timestampMs: local(16, 9, 0, 0),
    }),
    entry({ message: "old work", timestampMs: local(16, 9, 1, 0) }),
  ]);
  const current = [
    rowOf({
      category: "session",
      message: "session started \u00b7 app v1.2.3 \u00b7 macOS aarch64 \u00b7 pid 200",
      timestampMs: local(17, 14, 0, 0),
    }),
    rowOf({ message: "new work", timestampMs: local(17, 14, 1, 0) }),
  ];

  const off = renderWindow(windowLog({ entries: current, historyEntries: history }));
  assert.ok(!off.includes("old work"), "earlier launches stay out until asked for");
  assert.ok(!off.includes(escapeHtml(labels.unexpectedEnd)));
  assert.ok(stripTags(off).includes(escapeHtml(labels.counter(2, 2))));

  const on = renderWindow(
    windowLog({ entries: current, historyEntries: history, historyEnabled: true }),
  );
  assert.ok(on.indexOf("old work") !== -1 && on.indexOf("old work") < on.indexOf("new work"));
  assert.equal(occurrences(on, "session started"), 2);
  assert.equal(occurrences(on, escapeHtml(labels.unexpectedEnd)), 1);
  assert.ok(stripTags(on).includes(escapeHtml(labels.counter(4, 4))));
  for (const row of [history[0], current[0]]) {
    assert.ok(on.includes(escapeHtml(format.formatDateLabel(row.timestampMs, "en-CA"))));
  }
});

test("no component raised a React warning in any test of this file", () => {
  assert.deepEqual(reactWarnings, []);
});
