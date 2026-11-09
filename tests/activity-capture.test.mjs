// Frontend capture layer of the Activity Log: the logging `invoke` wrapper, the batching sink and
// everything that feeds it (console, uncaught errors, shortcuts, toasts, React Query).
//
// Source files are compiled with TypeScript and evaluated in a small module "world" whose
// imports are resolved from disk, with the Tauri modules replaced by recording doubles. Each
// world has its own module instances, so singletons never leak between tests.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix, sep } from "node:path";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const repoRoot = new URL("../", import.meta.url);
const readSource = (path) => readFileSync(new URL(path, repoRoot), "utf8");
const sourceExists = (path) => existsSync(new URL(path, repoRoot));

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(rounds = 4) {
  for (let round = 0; round < rounds; round += 1) await tick();
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, description) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await sleep(5);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function outcomeOf(promise) {
  try {
    return { rejected: false, value: await promise };
  } catch (error) {
    return { rejected: true, reason: error };
  }
}

// ---------------------------------------------------------------------------------------------
// Module world
// ---------------------------------------------------------------------------------------------

const compiledSources = new Map();
function compile(path) {
  if (!compiledSources.has(path)) {
    const { outputText } = ts.transpileModule(readSource(path), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: path,
    });
    compiledSources.set(path, outputText);
  }
  return compiledSources.get(path);
}

function resolveSource(fromPath, specifier) {
  const base = posix.join(posix.dirname(fromPath), specifier);
  const found = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(
    sourceExists,
  );
  assert.ok(found, `cannot resolve ${specifier} from ${fromPath}`);
  return found;
}

const CONSOLE_METHODS = ["error", "warn", "info", "log", "debug"];

function createConsoleSpy() {
  const calls = [];
  const spy = { calls };
  for (const method of CONSOLE_METHODS) {
    spy[method] = (...args) => {
      calls.push({ method, args });
    };
  }
  return spy;
}

// `overrides` replace a source module (keyed by its repo path); `doubles` replace bare imports.
// `console`, `window` and `document` are what the evaluated sources see as those globals.
function createWorld({
  overrides = {},
  doubles = {},
  console: worldConsole = createConsoleSpy(),
  window: worldWindow,
  document: worldDocument,
} = {}) {
  const modules = new Map();

  function load(path) {
    if (path in overrides) return overrides[path];
    const cached = modules.get(path);
    if (cached) return cached.exports;
    const module = { exports: {} };
    modules.set(path, module);
    const require = (specifier) => {
      if (specifier.startsWith(".")) return load(resolveSource(path, specifier));
      if (specifier in doubles) return doubles[specifier];
      assert.ok(
        !specifier.startsWith("@tauri-apps/"),
        `${path} imports ${specifier} without a test double`,
      );
      return nodeRequire(specifier);
    };
    new Function("require", "module", "exports", "console", "window", "document", compile(path))(
      require,
      module,
      module.exports,
      worldConsole,
      worldWindow,
      worldDocument,
    );
    return module.exports;
  }

  return { load, console: worldConsole };
}

// ---------------------------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------------------------

// Stands in for `@tauri-apps/api/core` and `@tauri-apps/api/event`.
function createTauri() {
  const calls = [];
  const listened = [];
  const handlers = new Map();
  const state = {
    underTauri: true,
    isTauriThrows: false,
    listenFails: false,
    respond: async () => ({ verbose: false }),
  };
  const core = {
    isTauri() {
      if (state.isTauriThrows) throw new Error("isTauri exploded");
      return state.underTauri;
    },
    invoke(command, args, options) {
      calls.push({ command, args, options });
      return state.respond(command, args, options);
    },
    convertFileSrc: (path) => `asset://${path}`,
  };
  const event = {
    async listen(name, handler) {
      if (state.listenFails) throw new Error("listen failed");
      listened.push(name);
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
      return () => handlers.get(name).delete(handler);
    },
  };
  return {
    calls,
    listened,
    state,
    doubles: { "@tauri-apps/api/core": core, "@tauri-apps/api/event": event },
    sent: () => calls.filter((call) => call.command === "record_frontend_activity"),
    emit(name, payload) {
      for (const handler of handlers.get(name) ?? []) handler({ event: name, payload });
    },
  };
}

// Stands in for `src/utils/activityLogSink.ts` and records what the capture sources log.
function createRecorder({ verbose = false, order } = {}) {
  const entries = [];
  const state = { verbose, started: 0, throwOnLog: false, onLog: undefined };
  return {
    entries,
    state,
    module: {
      logActivity(level, category, message, extra) {
        if (state.throwOnLog) throw new Error("logActivity exploded");
        order?.push("record");
        entries.push(
          extra === undefined ? { level, category, message } : { level, category, message, extra },
        );
        state.onLog?.();
      },
      isActivityVerbose: () => state.verbose,
      startActivitySink() {
        state.started += 1;
      },
    },
  };
}

const SINK_PATH = "src/utils/activityLogSink.ts";

function trackListeners(target) {
  const added = [];
  const addEventListener = target.addEventListener.bind(target);
  target.addEventListener = (type, listener, options) => {
    added.push(type);
    return addEventListener(type, listener, options);
  };
  target.added = added;
  return target;
}

const createFakeWindow = () => trackListeners(new EventTarget());
const createFakeDocument = () =>
  trackListeners(Object.assign(new EventTarget(), { visibilityState: "visible" }));

function useMockTimers(t, now = 1_700_000_000_000) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  t.after(() => mock.timers.reset());
  return { tick: (ms) => mock.timers.tick(ms) };
}

function watchUnhandledRejections(t) {
  const seen = [];
  const handler = (reason) => seen.push(reason);
  process.on("unhandledRejection", handler);
  t.after(() => process.off("unhandledRejection", handler));
  return seen;
}

// ---------------------------------------------------------------------------------------------
// Arg summariser
// ---------------------------------------------------------------------------------------------

const { summarizeActivityArgs: summarize, MAX_ARGS_SUMMARY_CHARS } = createWorld().load(
  "src/utils/activityArgs.ts",
);

test("args: numbers, booleans and null are shown, undefined is left out", () => {
  assert.equal(
    summarize({ count: 3, ok: true, off: false, nothing: null, skipped: undefined }),
    "count: 3, ok: true, off: false, nothing: null",
  );
});

test("args: ids and a few enum-like fields show their values", () => {
  assert.equal(
    summarize({
      assetId: "abc-123",
      albumId: "a1b2",
      id: "x_1",
      kind: "photo",
      year: 2024,
      month: 3,
      quality: "preview",
      visibility: "archive",
    }),
    'assetId: "abc-123", albumId: "a1b2", id: "x_1", kind: "photo", year: 2024, month: 3, quality: "preview", visibility: "archive"',
  );
  assert.equal(
    summarize({ albumId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", albumName: "Summer trip" }),
    'albumId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", albumName: "<11 chars>"',
  );
});

test("args: every other string is reduced to its length", () => {
  assert.equal(
    summarize({
      albumName: "Holiday 2024",
      note: "hello",
      title: "x".repeat(300),
      kind: "",
      format: "jpeg",
    }),
    'albumName: "<12 chars>", note: "<5 chars>", title: "<300 chars>", kind: "<0 chars>", format: "<4 chars>"',
  );
});

test("args: values of secret-like keys are never shown, even for id or enum keys", () => {
  const keys = [
    "token",
    "accessToken",
    "secret",
    "clientSecret",
    "password",
    "passwd",
    "authorization",
    "Authorization",
    "cookie",
    "apiKey",
    "api_key",
    "api-key",
    "credential",
    "credentials",
    "session",
    "sessionId",
    "serverUrl",
    "url",
    "imageUrl",
    "email",
    "userEmail",
    "path",
    "filePath",
    "name",
    "albumName",
    "description",
    "query",
    "searchQuery",
    "text",
    "bodyText",
  ];
  for (const key of keys) {
    const value = `value-of-${key}-xyz`;
    const summary = summarize({ [key]: value });
    assert.ok(!summary.includes("value-of-"), `${key} leaked its value: ${summary}`);
    assert.equal(summary, `${key}: "<${value.length} chars>"`);
  }
  assert.equal(summarize({ sessionId: "abc" }), 'sessionId: "<3 chars>"');
  assert.equal(summarize({ tokenIds: ["a1", "b2"] }), "tokenIds: [2 items]");
});

test("args: ids are shown only when short and made of plain id characters", () => {
  assert.equal(summarize({ assetId: "a".repeat(40) }), `assetId: "${"a".repeat(40)}"`);
  assert.equal(summarize({ assetId: "a".repeat(41) }), 'assetId: "<41 chars>"');
  assert.equal(summarize({ assetId: "a b" }), 'assetId: "<3 chars>"');
  assert.equal(summarize({ assetId: "../etc/passwd" }), 'assetId: "<13 chars>"');
  assert.equal(summarize({ kind: "x".repeat(25) }), 'kind: "<25 chars>"');
  assert.equal(summarize({ kind: "has space" }), 'kind: "<9 chars>"');
});

test("args: arrays show a count, and id arrays also the first two ids", () => {
  assert.equal(
    summarize({ assetIds: ["a1", "b2", "c3", "d4", "e5"] }),
    "assetIds: [5 items: a1, b2, …]",
  );
  assert.equal(summarize({ assetIds: ["a1"] }), "assetIds: [1 item: a1]");
  assert.equal(summarize({ assetIds: ["a1", "b2"] }), "assetIds: [2 items: a1, b2]");
  assert.equal(summarize({ assetIds: [] }), "assetIds: [0 items]");
  assert.equal(summarize({ assetIds: [1, 2, 3] }), "assetIds: [3 items]");
  assert.equal(summarize({ assetIds: ["has space", "b2"] }), "assetIds: [2 items]");
  assert.equal(summarize({ names: ["Trip", "Holiday"] }), "names: [2 items]");
  const huge = Array.from({ length: 1_000_000 }, (_, index) => `id${index}`);
  assert.equal(summarize({ assetIds: huge }), "assetIds: [1000000 items: id0, id1, …]");
});

test("args: objects, functions, symbols and bigint are summarised without their content", () => {
  assert.equal(
    summarize({ options: { deep: { secret: "x" } }, callback() {}, marker: Symbol("m"), big: 10n }),
    "options: {…}, callback: <function>, marker: <symbol>, big: 10",
  );
});

test("args: top-level values that are not objects", () => {
  assert.equal(summarize(undefined), "");
  assert.equal(summarize(null), "");
  assert.equal(summarize({}), "");
  assert.equal(summarize("secret text"), '"<11 chars>"');
  assert.equal(summarize(42), "42");
  assert.equal(summarize(true), "true");
  assert.equal(summarize([1, 2]), "[2 items]");
  assert.equal(summarize(new Uint8Array(5)), "<5 bytes>");
  assert.equal(summarize(new ArrayBuffer(8)), "<8 bytes>");
});

test("args: at most 12 keys, 32 key characters and 200 characters are reported", () => {
  const many = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`k${index}`, index]));
  assert.equal(
    summarize(many),
    "k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7, k8: 8, k9: 9, k10: 10, k11: 11, …",
  );

  const wide = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `key_${String(index).padStart(2, "0")}`.padEnd(30, "x"),
      123456789,
    ]),
  );
  const capped = summarize(wide);
  assert.equal(capped.length, MAX_ARGS_SUMMARY_CHARS);
  assert.equal(MAX_ARGS_SUMMARY_CHARS, 200);
  assert.ok(capped.endsWith("…"));
  assert.ok(capped.startsWith(`${"key_00".padEnd(30, "x")}: 123456789, `));

  assert.equal(summarize({ ["k".repeat(40)]: 1 }), `${"k".repeat(32)}: 1`);
  assert.equal(summarize({ "bad key/with<chars>": 1 }), "bad?key?with?chars?: 1");
});

test("args: circular objects, throwing getters, hostile proxies and exotic values never throw", () => {
  const circular = { x: 1 };
  circular.self = circular;
  assert.equal(summarize(circular), "x: 1, self: {…}");

  const withGetter = { ok: 1 };
  Object.defineProperty(withGetter, "boom", {
    enumerable: true,
    get() {
      throw new Error("getter exploded");
    },
  });
  assert.equal(summarize(withGetter), "ok: 1, boom: <unreadable>");

  const throwingProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("ownKeys exploded");
      },
    },
  );
  assert.equal(summarize(throwingProxy), "<unreadable>");
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(summarize(proxy), "<unreadable>");

  const bare = Object.create(null);
  bare.assetId = "a1";
  bare.n = 2;
  assert.equal(summarize(bare), 'assetId: "a1", n: 2');

  const exotic = [
    undefined,
    null,
    0,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "",
    Symbol("s"),
    10n,
    () => {},
    new Date(),
    /re/,
    new Map([[1, 2]]),
    new Set([1]),
    new Error("e"),
    Promise.resolve(),
    new WeakMap(),
    Object.freeze({ a: 1 }),
    [undefined],
    [[1]],
    [Symbol("x")],
    throwingProxy,
  ];
  for (const value of exotic) {
    for (const args of [value, { value }, { assetIds: [value, value, value] }]) {
      const summary = summarize(args);
      assert.equal(typeof summary, "string");
      assert.ok(summary.length <= MAX_ARGS_SUMMARY_CHARS);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Invoke policy
// ---------------------------------------------------------------------------------------------

const policy = createWorld().load("src/utils/activityInvokePolicy.ts");

test("policy: thresholds are 500 ms for slow commands and 5 s for pending ones", () => {
  assert.equal(policy.SLOW_COMMAND_MS, 500);
  assert.equal(policy.PENDING_COMMAND_MS, 5000);
});

test("policy: plugin commands and the activity-log commands are never logged", () => {
  const unlogged = [
    "get_activity_log_entries",
    "get_activity_log_history",
    "get_activity_log_info",
    "record_frontend_activity",
    "set_activity_log_verbose",
    "clear_activity_log",
    "open_activity_log_window",
    "plugin:event|listen",
    "plugin:log|log",
    "plugin:window|set_title",
  ];
  for (const command of unlogged) {
    assert.equal(policy.isUnloggedCommand(command), true, command);
  }
  for (const command of [
    "get_sync_status",
    "plugin",
    "my_plugin:thing",
    "activity_log",
    "get_activity_log_entries_extra",
    "record_frontend_activity2",
    "clear_activity_log_history",
  ]) {
    assert.equal(policy.isUnloggedCommand(command), false, command);
  }
});

test("policy: plain reads and housekeeping are routine, mutations and sync are actions", () => {
  const routine = [
    "get_sync_status",
    "get_cached_assets",
    "list_accounts",
    "check_server_connection",
    "read_something",
    "is_video_download_complete",
    "has_cache",
    "can_manage_album_sharing",
    "find_asset",
    "search_assets",
    "query_assets",
    "load_settings",
    "count_assets",
    "peek_queue",
    "resolve_path",
    "calculate_grid_layout",
    "update_app_menu",
    "track_media_event",
    "record_recent_album",
  ];
  const actions = [
    "rename_album",
    "delete_asset",
    "update_asset_favorite",
    "start_asset_sync",
    "force_full_asset_sync",
    "fetch_albums",
    "refresh_album_assets",
    "scan_saved_local_files",
    "begin_media_edit",
    "copy_assets_to_local_folder",
    "check_for_new_assets",
    "get_or_create_album_share_link",
    "get_oauth_authorization_url",
    "get_asset_playback",
  ];
  for (const command of routine) assert.equal(policy.isRoutineCommand(command), true, command);
  for (const command of actions) assert.equal(policy.isRoutineCommand(command), false, command);
});

test("policy: a routine read is debug below 500 ms and warn + slow from 500 ms", () => {
  const cases = [
    [0, "debug", false],
    [499, "debug", false],
    [499.4, "debug", false],
    [499.5, "warn", true],
    [500, "warn", true],
    [1480, "warn", true],
  ];
  for (const [elapsed, level, slow] of cases) {
    assert.deepEqual(
      policy.classifyInvokeSuccess("get_sync_status", elapsed),
      { level, durationMs: Math.round(elapsed), slow },
      `get_sync_status after ${elapsed}ms`,
    );
  }
});

test("policy: an action is info below 500 ms and warn + slow from 500 ms", () => {
  assert.deepEqual(policy.classifyInvokeSuccess("rename_album", 499), {
    level: "info",
    durationMs: 499,
    slow: false,
  });
  assert.deepEqual(policy.classifyInvokeSuccess("rename_album", 500), {
    level: "warn",
    durationMs: 500,
    slow: true,
  });
  assert.deepEqual(policy.classifyInvokeSuccess("rename_album", 12.4), {
    level: "info",
    durationMs: 12,
    slow: false,
  });
});

test("policy: durations are whole non-negative milliseconds", () => {
  for (const elapsed of [Number.NaN, -5, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(policy.classifyInvokeSuccess("rename_album", elapsed), {
      level: "info",
      durationMs: 0,
      slow: false,
    });
  }
  assert.equal(policy.wholeMs(7.5), 8);
});

test("policy: failures are errors, offline failures are warnings, slow ones are flagged", () => {
  assert.deepEqual(policy.classifyInvokeFailure("disk full", 12), {
    level: "error",
    durationMs: 12,
    slow: false,
  });
  for (const text of ["offline: server unreachable", "  Offline: x", "OFFLINE:x"]) {
    assert.equal(policy.classifyInvokeFailure(text, 3).level, "warn", text);
  }
  for (const text of ["network offline: x", "went offline", "offline"]) {
    assert.equal(policy.classifyInvokeFailure(text, 3).level, "error", text);
  }
  assert.equal(policy.classifyInvokeFailure("boom", 499).slow, false);
  assert.equal(policy.classifyInvokeFailure("boom", 500).slow, true);
  assert.deepEqual(policy.classifyInvokeFailure("offline: down", 2000), {
    level: "warn",
    durationMs: 2000,
    slow: true,
  });
});

test("policy: error text comes from message when there is one and is capped at 500 chars", () => {
  assert.equal(policy.describeError(new Error("disk full")), "disk full");
  assert.equal(policy.describeError({ message: "from object" }), "from object");
  assert.equal(policy.describeError("plain string"), "plain string");
  assert.equal(policy.describeError(5), "5");
  assert.equal(policy.describeError(null), "null");
  assert.equal(policy.describeError(undefined), "undefined");
  assert.equal(policy.describeError({ code: 1 }), "[object Object]");
  assert.equal(
    policy.describeError({
      get message() {
        throw new Error("getter exploded");
      },
    }),
    "unprintable error",
  );
  assert.equal(policy.describeError(Object.create(null)), "unprintable error");
  assert.equal(policy.describeError("x".repeat(500)), "x".repeat(500));
  assert.equal(policy.describeError("x".repeat(600)), `${"x".repeat(500)}…`);
});

test("policy: durations are worded like the Rust side", () => {
  const cases = [
    [0, "0ms"],
    [999, "999ms"],
    [1000, "1,000ms"],
    [1480, "1,480ms"],
    [5000, "5,000ms"],
    [1234567, "1,234,567ms"],
    [12.6, "13ms"],
    [Number.NaN, "0ms"],
    [-3, "0ms"],
  ];
  for (const [ms, text] of cases) assert.equal(policy.formatDurationMs(ms), text);
});

test("policy: entry messages", () => {
  assert.equal(
    policy.successMessage("rename_album", 'albumId: "a1"', 12),
    'rename_album(albumId: "a1") -> ok in 12ms',
  );
  assert.equal(
    policy.successMessage("get_sync_status", "", 1480),
    "get_sync_status() -> ok in 1,480ms",
  );
  assert.equal(
    policy.failureMessage("rename_album", 'albumId: "a1"', 7, "disk full"),
    'rename_album(albumId: "a1") -> failed in 7ms: disk full',
  );
  assert.equal(
    policy.pendingMessage("start_asset_sync", ""),
    "start_asset_sync() still running after 5,000ms",
  );
});

// ---------------------------------------------------------------------------------------------
// Invoke wrapper
// ---------------------------------------------------------------------------------------------

const { withActivityLogging } = createWorld().load("src/utils/activityInvoke.ts");

// A fake clock, fake timers and a scriptable "raw invoke". Every dependency is read lazily by the
// wrapper, so tests can break one of them after creation.
function createWrapperHarness({ call } = {}) {
  const clock = { time: 1000 };
  const behavior = { ms: 0, result: undefined, hasError: false, error: undefined, wait: undefined };
  const harness = {
    verbose: false,
    logs: [],
    timers: [],
    remembered: [],
    calls: [],
    behavior,
    clock,
  };
  harness.deps = {
    log: (level, category, message, extra) =>
      harness.logs.push({ level, category, message, extra }),
    isVerbose: () => harness.verbose,
    now: () => clock.time,
    setTimer(task, delayMs) {
      const timer = { task, delayMs, cleared: false };
      harness.timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    rememberError: (text) => harness.remembered.push(text),
  };
  const rawCall =
    call ??
    (async (command, args, options) => {
      harness.calls.push({ command, args, options });
      if (behavior.wait) await behavior.wait;
      clock.time += behavior.ms;
      if (behavior.hasError) throw behavior.error;
      return behavior.result;
    });
  harness.invoke = withActivityLogging(rawCall, harness.deps);
  harness.fail = (error, ms = 0) => {
    behavior.hasError = true;
    behavior.error = error;
    behavior.ms = ms;
  };
  return harness;
}

test("wrapper: a successful action is logged at info with its duration and the value is returned untouched", async () => {
  const h = createWrapperHarness();
  const result = { answer: 42 };
  h.behavior.result = result;
  h.behavior.ms = 12;
  const value = await h.invoke("rename_album", { albumId: "a1", albumName: "Secret" });
  assert.equal(value, result);
  assert.deepEqual(h.logs, [
    {
      level: "info",
      category: "command",
      message: 'rename_album(albumId: "a1", albumName: "<6 chars>") -> ok in 12ms',
      extra: { durationMs: 12, slow: false },
    },
  ]);
});

test("wrapper: routine reads are only written while Verbose is on", async () => {
  const h = createWrapperHarness();
  h.behavior.ms = 5;
  await h.invoke("get_sync_status");
  assert.deepEqual(h.logs, []);
  h.verbose = true;
  await h.invoke("get_sync_status");
  assert.deepEqual(h.logs, [
    {
      level: "debug",
      category: "command",
      message: "get_sync_status() -> ok in 5ms",
      extra: { durationMs: 5, slow: false },
    },
  ]);
});

test("wrapper: a routine read stays quiet at 499 ms and is a slow warning at 500 ms, even with Verbose off", async () => {
  const h = createWrapperHarness();
  assert.equal(h.verbose, false);
  h.behavior.ms = 499;
  await h.invoke("get_cached_assets", { page: 2 });
  assert.deepEqual(h.logs, []);
  h.behavior.ms = 500;
  await h.invoke("get_cached_assets", { page: 2 });
  assert.deepEqual(h.logs, [
    {
      level: "warn",
      category: "command",
      message: "get_cached_assets(page: 2) -> ok in 500ms",
      extra: { durationMs: 500, slow: true },
    },
  ]);
});

test("wrapper: an action is info at 499 ms and a slow warning at 500 ms", async () => {
  const h = createWrapperHarness();
  h.behavior.ms = 499;
  await h.invoke("start_asset_sync");
  h.behavior.ms = 500;
  await h.invoke("start_asset_sync");
  h.behavior.ms = 1480;
  await h.invoke("start_asset_sync");
  assert.deepEqual(
    h.logs.map(({ level, message, extra }) => [level, message, extra.slow]),
    [
      ["info", "start_asset_sync() -> ok in 499ms", false],
      ["warn", "start_asset_sync() -> ok in 500ms", true],
      ["warn", "start_asset_sync() -> ok in 1,480ms", true],
    ],
  );
});

test("wrapper: failures rethrow the original value, whatever it is", async () => {
  const failures = [new Error("boom"), "plain text", { code: 7 }, null, undefined, 0];
  for (const failure of failures) {
    const h = createWrapperHarness();
    h.fail(failure);
    const outcome = await outcomeOf(h.invoke("rename_album"));
    assert.equal(outcome.rejected, true);
    assert.ok(Object.is(outcome.reason, failure), `rethrown ${String(failure)} was replaced`);
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0].level, "error");
  }
});

test("wrapper: a failure is an error entry with the error text, and the text is remembered", async () => {
  const h = createWrapperHarness();
  h.fail(new Error("disk full"), 7);
  await outcomeOf(h.invoke("rename_album", { albumId: "a1" }));
  assert.deepEqual(h.logs, [
    {
      level: "error",
      category: "command",
      message: 'rename_album(albumId: "a1") -> failed in 7ms: disk full',
      extra: { durationMs: 7, slow: false },
    },
  ]);
  assert.deepEqual(h.remembered, ["disk full"]);
});

test("wrapper: failures of routine reads are logged even with Verbose off", async () => {
  const h = createWrapperHarness();
  h.fail("backend rejected the request", 4);
  await outcomeOf(h.invoke("get_cached_assets"));
  assert.deepEqual(
    h.logs.map(({ level, message }) => [level, message]),
    [["error", "get_cached_assets() -> failed in 4ms: backend rejected the request"]],
  );
});

test("wrapper: an offline: failure is a warning, not an error", async () => {
  const h = createWrapperHarness();
  h.fail("offline: server unreachable", 3);
  const outcome = await outcomeOf(h.invoke("check_server_connection"));
  assert.equal(outcome.reason, "offline: server unreachable");
  assert.deepEqual(
    h.logs.map(({ level, message }) => [level, message]),
    [["warn", "check_server_connection() -> failed in 3ms: offline: server unreachable"]],
  );
  assert.deepEqual(h.remembered, ["offline: server unreachable"]);
});

test("wrapper: long error text is capped at 500 characters", async () => {
  const h = createWrapperHarness();
  h.fail(new Error("x".repeat(600)));
  await outcomeOf(h.invoke("rename_album"));
  assert.ok(h.logs[0].message.endsWith(`: ${"x".repeat(500)}…`));
  assert.deepEqual(h.remembered, [`${"x".repeat(500)}…`]);
});

test("wrapper: a failure that took 500 ms or more is flagged slow", async () => {
  for (const [ms, slow] of [
    [499, false],
    [500, true],
  ]) {
    const h = createWrapperHarness();
    h.fail(new Error("boom"), ms);
    await outcomeOf(h.invoke("rename_album"));
    assert.equal(h.logs[0].level, "error");
    assert.equal(h.logs[0].extra.slow, slow, `failure after ${ms}ms`);
    assert.equal(h.logs[0].extra.durationMs, ms);
  }
});

test("wrapper: plugin and activity-log commands are delegated without any logging", async () => {
  const unlogged = [
    "plugin:event|listen",
    "plugin:window|set_title",
    "get_activity_log_entries",
    "get_activity_log_history",
    "get_activity_log_info",
    "record_frontend_activity",
    "set_activity_log_verbose",
    "clear_activity_log",
    "open_activity_log_window",
  ];
  for (const command of unlogged) {
    const h = createWrapperHarness();
    h.behavior.result = { ok: command };
    h.behavior.ms = 900;
    const args = { sinceSeq: 1 };
    const options = { headers: {} };
    assert.deepEqual(await h.invoke(command, args, options), { ok: command });
    assert.equal(h.calls[0].command, command);
    assert.equal(h.calls[0].args, args);
    assert.equal(h.calls[0].options, options);

    h.fail("nope", 900);
    const outcome = await outcomeOf(h.invoke(command));
    assert.equal(outcome.reason, "nope");
    assert.deepEqual([h.logs, h.timers, h.remembered], [[], [], []], command);
  }
});

test("wrapper: a call still pending after 5 s records exactly one warning and the timer is one-shot", async () => {
  const h = createWrapperHarness();
  const gate = deferred();
  h.behavior.wait = gate.promise;
  h.behavior.ms = 6000;
  h.behavior.result = "done";

  const pending = h.invoke("start_asset_sync", { force: true });
  await tick();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delayMs, 5000);
  assert.equal(h.timers[0].cleared, false);
  assert.deepEqual(h.logs, []);

  h.timers[0].task();
  assert.deepEqual(h.logs, [
    {
      level: "warn",
      category: "command",
      message: "start_asset_sync(force: true) still running after 5,000ms",
      extra: undefined,
    },
  ]);
  assert.equal(h.timers.length, 1);

  gate.resolve();
  assert.equal(await pending, "done");
  assert.equal(h.timers[0].cleared, true);
  assert.deepEqual(
    h.logs.map(({ level, message, extra }) => [level, message, extra?.slow]),
    [
      ["warn", "start_asset_sync(force: true) still running after 5,000ms", undefined],
      ["warn", "start_asset_sync(force: true) -> ok in 6,000ms", true],
    ],
  );
});

test("wrapper: every pending timer is cleared when its call completes", async () => {
  const h = createWrapperHarness();
  for (let index = 0; index < 5; index += 1) await h.invoke("rename_album");
  h.fail(new Error("x"));
  for (let index = 0; index < 5; index += 1) await outcomeOf(h.invoke("rename_album"));
  assert.equal(h.timers.length, 10);
  assert.ok(h.timers.every((timer) => timer.cleared && timer.delayMs === 5000));
});

test("wrapper: a logging problem never breaks the call or changes its outcome", async () => {
  const breakers = {
    log: (deps) => {
      deps.log = () => {
        throw new Error("log exploded");
      };
    },
    setTimer: (deps) => {
      deps.setTimer = () => {
        throw new Error("setTimer exploded");
      };
    },
    clearTimer: (deps) => {
      deps.clearTimer = () => {
        throw new Error("clearTimer exploded");
      };
    },
    now: (deps) => {
      deps.now = () => {
        throw new Error("now exploded");
      };
    },
    isVerbose: (deps) => {
      deps.isVerbose = () => {
        throw new Error("isVerbose exploded");
      };
    },
    rememberError: (deps) => {
      deps.rememberError = () => {
        throw new Error("rememberError exploded");
      };
    },
  };
  for (const [name, breakIt] of Object.entries(breakers)) {
    const succeeding = createWrapperHarness();
    breakIt(succeeding.deps);
    succeeding.behavior.result = "fine";
    assert.equal(await succeeding.invoke("get_sync_status"), "fine", `${name}: read`);
    assert.equal(await succeeding.invoke("rename_album"), "fine", `${name}: action`);

    const failing = createWrapperHarness();
    breakIt(failing.deps);
    const failure = new Error("original");
    failing.fail(failure);
    const outcome = await outcomeOf(failing.invoke("rename_album"));
    assert.ok(outcome.rejected && outcome.reason === failure, `${name}: failure`);
  }
});

test("wrapper: a broken timer or a broken error memory does not lose the log entry", async () => {
  const noTimer = createWrapperHarness();
  noTimer.deps.setTimer = () => {
    throw new Error("setTimer exploded");
  };
  await noTimer.invoke("rename_album");
  assert.equal(noTimer.logs.length, 1);
  assert.equal(noTimer.logs[0].level, "info");

  const noMemory = createWrapperHarness();
  noMemory.deps.rememberError = () => {
    throw new Error("rememberError exploded");
  };
  noMemory.fail(new Error("disk full"), 2);
  await outcomeOf(noMemory.invoke("rename_album"));
  assert.deepEqual(
    noMemory.logs.map(({ level, message }) => [level, message]),
    [["error", "rename_album() -> failed in 2ms: disk full"]],
  );
});

test("wrapper: arguments are only summarised when an entry is written, and only once per call", async () => {
  let reads = 0;
  const args = {
    get assetId() {
      reads += 1;
      return "a1";
    },
  };
  const h = createWrapperHarness();
  await h.invoke("get_sync_status", args);
  assert.equal(reads, 0, "a skipped debug entry must not summarise");

  h.verbose = true;
  await h.invoke("get_sync_status", args);
  assert.equal(reads, 1);

  reads = 0;
  const gate = deferred();
  h.behavior.wait = gate.promise;
  h.behavior.ms = 6000;
  const pending = h.invoke("start_asset_sync", args);
  await tick();
  h.timers.at(-1).task();
  gate.resolve();
  await pending;
  assert.equal(reads, 1, "the pending warning and the final entry share one summary");
});

test("wrapper: the command, args and options reach the wrapped call untouched", async () => {
  const h = createWrapperHarness();
  const args = { assetId: "a1" };
  const options = { headers: { "x-test": "1" } };
  await h.invoke("rename_album", args, options);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].command, "rename_album");
  assert.equal(h.calls[0].args, args);
  assert.equal(h.calls[0].options, options);
});

test("wrapper: a call that throws synchronously becomes a rejected promise and is logged", async () => {
  const failure = new Error("sync boom");
  const h = createWrapperHarness({
    call: () => {
      throw failure;
    },
  });
  const promise = h.invoke("rename_album");
  assert.ok(promise instanceof Promise);
  const outcome = await outcomeOf(promise);
  assert.ok(outcome.rejected && outcome.reason === failure);
  assert.deepEqual(
    h.logs.map(({ level, message }) => [level, message]),
    [["error", "rename_album() -> failed in 0ms: sync boom"]],
  );
});

// ---------------------------------------------------------------------------------------------
// Recent error memory
// ---------------------------------------------------------------------------------------------

const { createRecentErrorSet } = createWorld().load("src/utils/recentErrorSet.ts");

function createErrorSetHarness(options = {}) {
  const clock = { time: 0 };
  return { clock, set: createRecentErrorSet({ now: () => clock.time, ...options }) };
}

test("recent errors: a remembered text is found and other texts are not", () => {
  const { set } = createErrorSetHarness();
  assert.equal(set.has("disk full"), false);
  set.remember("disk full");
  assert.equal(set.has("disk full"), true);
  assert.equal(set.has("disk full!"), false);
});

test("recent errors: texts are matched on their trimmed first 200 characters", () => {
  const { set } = createErrorSetHarness();
  set.remember("  disk full  ");
  assert.equal(set.has("disk full"), true);
  assert.equal(set.has("disk full\n"), true);

  const head = "e".repeat(200);
  set.remember(`${head}tail A`);
  assert.equal(set.has(`${head}tail B`), true);
  assert.equal(set.has("e".repeat(199)), false);
});

test("recent errors: an entry expires once it is older than 5 s", () => {
  const { clock, set } = createErrorSetHarness();
  set.remember("disk full");
  clock.time = 5000;
  assert.equal(set.has("disk full"), true);
  clock.time = 5001;
  assert.equal(set.has("disk full"), false);
});

test("recent errors: remembering a text again refreshes its age", () => {
  const { clock, set } = createErrorSetHarness();
  set.remember("disk full");
  clock.time = 4000;
  set.remember("disk full");
  clock.time = 8000;
  assert.equal(set.has("disk full"), true);
  clock.time = 9001;
  assert.equal(set.has("disk full"), false);
});

test("recent errors: only the newest 50 texts are kept", () => {
  const { set } = createErrorSetHarness();
  for (let index = 0; index < 50; index += 1) set.remember(`error ${index}`);
  for (let index = 0; index < 50; index += 1) assert.equal(set.has(`error ${index}`), true);
  set.remember("error 50");
  assert.equal(set.has("error 0"), false);
  assert.equal(set.has("error 1"), true);
  assert.equal(set.has("error 50"), true);
});

test("recent errors: a refreshed text survives eviction of the oldest one", () => {
  const { set } = createErrorSetHarness();
  for (let index = 0; index < 50; index += 1) set.remember(`error ${index}`);
  set.remember("error 0");
  set.remember("error 50");
  assert.equal(set.has("error 0"), true);
  assert.equal(set.has("error 1"), false);
});

test("recent errors: empty text is ignored and the limits can be configured", () => {
  const { set } = createErrorSetHarness();
  set.remember("");
  set.remember("   ");
  assert.equal(set.has(""), false);
  assert.equal(set.has("   "), false);

  const { clock, set: small } = createErrorSetHarness({ maxEntries: 2, ttlMs: 10 });
  small.remember("a");
  small.remember("b");
  small.remember("c");
  assert.deepEqual([small.has("a"), small.has("b"), small.has("c")], [false, true, true]);
  clock.time = 11;
  assert.equal(small.has("b"), false);
});

// ---------------------------------------------------------------------------------------------
// Batching sink (pure core)
// ---------------------------------------------------------------------------------------------

const sinkWorld = createWorld();
const { createActivitySink, FLUSH_DELAY_MS, MAX_BATCH_ENTRIES, MAX_QUEUED_ENTRIES } =
  sinkWorld.load("src/utils/activitySinkCore.ts");

// A manual scheduler and clock; `send` records batches and answers through `state.respond`.
function createSinkHarness() {
  const clock = { time: 1_700_000_000_000 };
  const timers = [];
  const batches = [];
  const state = { respond: async () => ({ verbose: false }), enabled: () => true };
  const sink = createActivitySink({
    send(entries) {
      batches.push(entries);
      return state.respond(entries);
    },
    schedule(task, delayMs) {
      const timer = { task, delayMs, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    now: () => clock.time,
    isEnabled: () => state.enabled(),
  });
  const harness = {
    sink,
    clock,
    timers,
    batches,
    state,
    liveTimers: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
    fire(timer = harness.liveTimers()[0]) {
      timer.fired = true;
      timer.task();
    },
    logMany(count, prefix = "m") {
      for (let index = 0; index < count; index += 1) sink.log("info", "app", `${prefix}${index}`);
    },
  };
  return harness;
}

test("sink core: constants", () => {
  assert.equal(FLUSH_DELAY_MS, 250);
  assert.equal(MAX_BATCH_ENTRIES, 200);
  assert.equal(MAX_QUEUED_ENTRIES, 2000);
});

test("sink core: entries carry whole-number timestamps and durations, slow only when set", async () => {
  const h = createSinkHarness();
  h.clock.time = 1_700_000_000_000.6;
  h.sink.log("info", "command", "first", { durationMs: 12.4, slow: false });
  h.sink.log("warn", "command", "second", { durationMs: 700.5, slow: true });
  h.sink.log("info", "ui", "third");
  h.sink.log("info", "ui", "nan", { durationMs: Number.NaN });
  h.sink.log("info", "ui", "infinite", { durationMs: Number.POSITIVE_INFINITY });
  h.sink.log("info", "ui", "negative", { durationMs: -5 });
  await h.sink.flush();
  const timestampMs = 1_700_000_000_001;
  assert.deepEqual(h.batches, [
    [
      { timestampMs, level: "info", category: "command", message: "first", durationMs: 12 },
      {
        timestampMs,
        level: "warn",
        category: "command",
        message: "second",
        durationMs: 701,
        slow: true,
      },
      { timestampMs, level: "info", category: "ui", message: "third" },
      { timestampMs, level: "info", category: "ui", message: "nan" },
      { timestampMs, level: "info", category: "ui", message: "infinite" },
      { timestampMs, level: "info", category: "ui", message: "negative", durationMs: 0 },
    ],
  ]);
});

test("sink core: entries are batched behind one 250 ms timer", async () => {
  const h = createSinkHarness();
  h.logMany(3);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delayMs, 250);
  assert.equal(h.batches.length, 0);

  h.fire();
  await h.sink.flush();
  assert.deepEqual(
    h.batches.map((batch) => batch.map((entry) => entry.message)),
    [["m0", "m1", "m2"]],
  );

  h.sink.log("info", "app", "later");
  assert.equal(h.timers.length, 2, "a new batch arms a new timer");
  assert.equal(h.liveTimers().length, 1);
});

test("sink core: at most 200 entries are sent per call", async () => {
  const h = createSinkHarness();
  h.logMany(450);
  h.fire();
  await h.sink.flush();
  assert.deepEqual(
    h.batches.map((batch) => batch.length),
    [200, 200, 50],
  );
  assert.deepEqual(
    h.batches.flat().map((entry) => entry.message),
    Array.from({ length: 450 }, (_, index) => `m${index}`),
  );
});

test("sink core: past 2000 queued entries the oldest are dropped and one notice reports it", async () => {
  const h = createSinkHarness();
  h.logMany(2005);
  h.fire();
  await h.sink.flush();
  const sent = h.batches.flat();
  assert.deepEqual(
    h.batches.map((batch) => batch.length),
    [...Array.from({ length: 10 }, () => 200), 1],
  );
  assert.equal(sent.length, 2001);
  assert.equal(sent[0].message, "m5");
  assert.equal(sent[1999].message, "m2004");
  assert.deepEqual(sent[2000], {
    timestampMs: h.clock.time,
    level: "warn",
    category: "app",
    message: "5 activity entries dropped",
  });
  assert.equal(sent.filter((entry) => entry.message.endsWith("dropped")).length, 1);
});

test("sink core: a single dropped entry is worded in the singular and reported only once", async () => {
  const h = createSinkHarness();
  h.logMany(2001);
  h.fire();
  await h.sink.flush();
  const sent = h.batches.flat();
  assert.equal(sent.at(-1).message, "1 activity entry dropped");
  assert.equal(sent[0].message, "m1");

  const before = h.batches.length;
  h.sink.log("info", "app", "next");
  h.fire();
  await h.sink.flush();
  assert.deepEqual(
    h.batches
      .slice(before)
      .flat()
      .map((entry) => entry.message),
    ["next"],
  );
});

test("sink core: debug entries are dropped while Verbose is off", async () => {
  const h = createSinkHarness();
  h.sink.log("debug", "command", "quiet");
  assert.equal(h.sink.isVerbose(), false);
  assert.equal(h.timers.length, 0, "a dropped entry must not even arm the timer");

  h.sink.setVerbose(true);
  assert.equal(h.sink.isVerbose(), true);
  h.sink.log("debug", "command", "loud");
  h.sink.log("info", "command", "always");
  await h.sink.flush();
  assert.deepEqual(
    h.batches.flat().map((entry) => entry.message),
    ["loud", "always"],
  );
});

test("sink core: Verbose follows the backend's boolean answer and ignores anything else", async () => {
  const h = createSinkHarness();
  const send = async (response) => {
    h.state.respond = async () => response;
    h.sink.log("info", "app", "ping");
    await h.sink.flush();
    return h.sink.isVerbose();
  };
  assert.equal(await send({ verbose: true }), true);
  for (const unusable of [undefined, null, 42, {}, { verbose: "yes" }, { verbose: 1 }]) {
    assert.equal(await send(unusable), true, `unusable response ${JSON.stringify(unusable)}`);
  }
  assert.equal(await send({ verbose: false }), false);
  for (const unusable of [undefined, null, {}, { verbose: "no" }]) {
    assert.equal(await send(unusable), false);
  }
});

test("sink core: a failing send is silent and its entries are counted in the next notice", async (t) => {
  const unhandled = watchUnhandledRejections(t);
  const h = createSinkHarness();
  h.state.respond = async () => {
    throw new Error("ipc down");
  };
  h.logMany(3);
  h.fire();
  await h.sink.flush();
  assert.equal(h.batches.length, 1);

  h.state.respond = () => {
    throw new Error("synchronous failure");
  };
  h.logMany(2, "again");
  h.fire();
  await h.sink.flush();

  h.state.respond = async () => ({ verbose: false });
  h.sink.log("info", "app", "recovered");
  h.fire();
  await h.sink.flush();

  assert.deepEqual(
    h.batches.slice(2).map((batch) => batch.map((entry) => entry.message)),
    [["recovered"], ["5 activity entries dropped"]],
  );
  await settle();
  assert.deepEqual(unhandled, []);
  assert.deepEqual(sinkWorld.console.calls, [], "the sink must never write to the console");
});

test("sink core: entries logged during a send go out as soon as it settles, without the timer", async () => {
  const h = createSinkHarness();
  const gate = deferred();
  h.state.respond = () =>
    h.batches.length === 1 ? gate.promise : Promise.resolve({ verbose: false });
  h.sink.log("info", "app", "a");
  h.fire();
  assert.equal(h.batches.length, 1);

  h.sink.log("info", "app", "b");
  assert.equal(h.batches.length, 1, "nothing is sent while the first call is in flight");
  gate.resolve({ verbose: false });
  await h.sink.flush();
  assert.deepEqual(
    h.batches.map((batch) => batch.map((entry) => entry.message)),
    [["a"], ["b"]],
  );
  assert.equal(h.timers[1].cancelled, true);
  assert.equal(h.timers[1].fired, false);
});

test("sink core: a timer firing during a send does not start a second concurrent send", async () => {
  const h = createSinkHarness();
  const gate = deferred();
  h.state.respond = () =>
    h.batches.length === 1 ? gate.promise : Promise.resolve({ verbose: false });
  h.sink.log("info", "app", "a");
  h.fire();
  h.sink.log("info", "app", "b");
  h.fire();
  assert.equal(h.batches.length, 1);

  gate.resolve({ verbose: false });
  await h.sink.flush();
  assert.deepEqual(
    h.batches.map((batch) => batch.map((entry) => entry.message)),
    [["a"], ["b"]],
  );
});

test("sink core: nothing is queued or sent while the sink is disabled", async () => {
  const h = createSinkHarness();
  h.state.enabled = () => false;
  h.logMany(3);
  h.sink.setVerbose(true);
  h.sink.log("debug", "app", "x");
  assert.equal(h.timers.length, 0);
  await h.sink.flush();
  assert.equal(h.batches.length, 0);

  h.state.enabled = () => {
    throw new Error("isEnabled exploded");
  };
  h.logMany(3);
  assert.equal(h.timers.length, 0);
  await h.sink.flush();
  assert.equal(h.batches.length, 0);
});

test("sink core: flush sends immediately and cancels the pending timer", async () => {
  const h = createSinkHarness();
  h.logMany(2);
  await h.sink.flush();
  assert.equal(h.batches.length, 1);
  assert.equal(h.timers[0].cancelled, true);
  assert.equal(h.liveTimers().length, 0);

  const before = h.batches.length;
  await h.sink.flush();
  assert.equal(h.batches.length, before, "an empty flush sends nothing");
});

test("sink core: concurrent flushes all resolve once the queue is empty", async () => {
  const h = createSinkHarness();
  h.logMany(450);
  await Promise.all([h.sink.flush(), h.sink.flush(), h.sink.flush()]);
  assert.deepEqual(
    h.batches.map((batch) => batch.length),
    [200, 200, 50],
  );
});

test("sink core: malformed input never throws and oversized text is cut", async () => {
  const h = createSinkHarness();
  assert.doesNotThrow(() => h.sink.log("info", undefined, "no category"));
  assert.doesNotThrow(() => h.sink.log("info", 42, "numeric category"));
  assert.doesNotThrow(() => h.sink.log("info", "app", undefined));
  assert.equal(h.timers.length, 0, "rejected entries are not queued");

  h.sink.log("info", "c".repeat(60), "m".repeat(9000));
  await h.sink.flush();
  const [entry] = h.batches.flat();
  assert.equal(entry.category.length, 48);
  assert.equal(entry.message.length, 8000);
});

// ---------------------------------------------------------------------------------------------
// Sink singleton (Tauri transport)
// ---------------------------------------------------------------------------------------------

// The real `activityLogSink.ts` against recording Tauri doubles, with a fake clock and timers.
function createSinkSingleton(t, { window: hasWindow = true, document: hasDocument = true } = {}) {
  const clock = useMockTimers(t);
  const tauri = createTauri();
  const win = createFakeWindow();
  const doc = createFakeDocument();
  const world = createWorld({
    doubles: tauri.doubles,
    window: hasWindow ? win : undefined,
    document: hasDocument ? doc : undefined,
  });
  return { ...world.load(SINK_PATH), clock, tauri, win, doc, console: world.console };
}

const messagesOf = (call) => call.args.entries.map((entry) => entry.message);
const infoCalls = (tauri) => tauri.calls.filter((call) => call.command === "get_activity_log_info");

test("sink: entries leave in one record_frontend_activity call 250 ms after the first one", async (t) => {
  const h = createSinkSingleton(t);
  const start = Date.now();
  h.logActivity("info", "command", "rename_album() -> ok in 12ms", { durationMs: 12 });
  h.clock.tick(100);
  h.logActivity("warn", "ui", "toast error: asset.deleteFailed");
  h.clock.tick(149);
  await settle();
  assert.equal(h.tauri.sent().length, 0, "nothing is sent before the 250 ms window closes");

  h.clock.tick(1);
  await settle();
  const sent = h.tauri.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options, undefined);
  assert.deepEqual(sent[0].args, {
    entries: [
      {
        timestampMs: start,
        level: "info",
        category: "command",
        message: "rename_album() -> ok in 12ms",
        durationMs: 12,
      },
      {
        timestampMs: start + 100,
        level: "warn",
        category: "ui",
        message: "toast error: asset.deleteFailed",
      },
    ],
  });
});

test("sink: it starts once on first use: one info request, one event listener, one hide-time flush", async (t) => {
  const h = createSinkSingleton(t);
  h.logActivity("info", "app", "one");
  h.logActivity("info", "app", "two");
  h.startActivitySink();
  h.startActivitySink();
  await settle();
  assert.equal(infoCalls(h.tauri).length, 1);
  assert.deepEqual(h.tauri.listened, ["activity-log:verbose"]);
  assert.deepEqual(h.win.added, ["pagehide"]);
  assert.deepEqual(h.doc.added, ["visibilitychange"]);
});

test("sink: the initial Verbose flag comes from get_activity_log_info", async (t) => {
  const h = createSinkSingleton(t);
  h.tauri.state.respond = async (command) =>
    command === "get_activity_log_info" ? { verbose: true, entries: 12 } : { verbose: true };
  assert.equal(h.isActivityVerbose(), false, "off until the backend says otherwise");
  h.startActivitySink();
  await settle();
  assert.equal(h.isActivityVerbose(), true);

  h.logActivity("debug", "app", "chatty");
  h.clock.tick(250);
  await settle();
  assert.deepEqual(h.tauri.sent().map(messagesOf), [["chatty"]]);
});

test("sink: a malformed get_activity_log_info answer leaves Verbose off", async () => {
  for (const answer of [null, undefined, "yes", {}, { verbose: "true" }, { verbose: 1 }]) {
    const tauri = createTauri();
    tauri.state.respond = async () => answer;
    const sink = createWorld({ doubles: tauri.doubles }).load(SINK_PATH);
    sink.startActivitySink();
    await settle();
    assert.equal(sink.isActivityVerbose(), false, `answer: ${JSON.stringify(answer)}`);
  }
});

test("sink: the activity-log:verbose event switches Verbose, non-boolean payloads are ignored", async (t) => {
  const h = createSinkSingleton(t);
  h.startActivitySink();
  await settle();
  assert.equal(h.isActivityVerbose(), false);

  h.tauri.emit("activity-log:verbose", true);
  assert.equal(h.isActivityVerbose(), true);
  for (const payload of ["false", 0, null, undefined, { verbose: false }]) {
    h.tauri.emit("activity-log:verbose", payload);
    assert.equal(h.isActivityVerbose(), true, `payload ${JSON.stringify(payload)} is ignored`);
  }
  h.tauri.emit("activity-log:verbose", false);
  assert.equal(h.isActivityVerbose(), false);
});

test("sink: every batch answer carries the current Verbose flag", async (t) => {
  const h = createSinkSingleton(t);
  h.tauri.state.respond = async (command) => ({ verbose: command === "record_frontend_activity" });
  h.logActivity("info", "app", "first");
  h.clock.tick(250);
  await settle();
  assert.equal(h.isActivityVerbose(), true);
});

test("sink: debug entries are dropped before queueing while Verbose is off, and sent once it is on", async (t) => {
  const h = createSinkSingleton(t);
  h.startActivitySink();
  await settle();
  h.logActivity("debug", "app", "dropped");
  h.clock.tick(1000);
  await settle();
  assert.equal(h.tauri.sent().length, 0, "a debug-only queue never even schedules a send");

  h.tauri.emit("activity-log:verbose", true);
  h.logActivity("debug", "app", "kept");
  h.clock.tick(250);
  await settle();
  assert.deepEqual(h.tauri.sent().map(messagesOf), [["kept"]]);
});

test("sink: pagehide flushes at once, visibilitychange only when the page became hidden", async (t) => {
  const h = createSinkSingleton(t);
  h.logActivity("info", "app", "before pagehide");
  h.win.dispatchEvent(new Event("pagehide"));
  await settle();
  assert.deepEqual(h.tauri.sent().map(messagesOf), [["before pagehide"]]);

  h.logActivity("info", "app", "while visible");
  h.doc.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.equal(h.tauri.sent().length, 1, "a page that is still visible has nothing to flush");

  h.doc.visibilityState = "hidden";
  h.doc.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.deepEqual(h.tauri.sent().map(messagesOf), [["before pagehide"], ["while visible"]]);
});

for (const [label, breakTauri] of [
  ["isTauri() is false", (tauri) => (tauri.state.underTauri = false)],
  ["isTauri() throws", (tauri) => (tauri.state.isTauriThrows = true)],
]) {
  test(`sink: outside Tauri (${label}) everything is a quiet no-op`, async (t) => {
    const h = createSinkSingleton(t);
    breakTauri(h.tauri);
    assert.doesNotThrow(() => h.logActivity("error", "app", "nobody is listening"));
    h.startActivitySink();
    h.clock.tick(5000);
    await h.flushActivity();
    await settle();
    assert.deepEqual(h.tauri.calls, []);
    assert.deepEqual(h.tauri.listened, []);
    assert.deepEqual(h.win.added, []);
    assert.deepEqual(h.doc.added, []);
    assert.equal(h.isActivityVerbose(), false);
    assert.equal(h.console.calls.length, 0);
  });
}

test("sink: without a window or a document only the hide-time flush is skipped", async (t) => {
  const noWindow = createSinkSingleton(t, { window: false, document: false });
  noWindow.logActivity("info", "app", "headless");
  noWindow.clock.tick(250);
  await settle();
  assert.deepEqual(noWindow.tauri.sent().map(messagesOf), [["headless"]]);
  assert.deepEqual(noWindow.tauri.listened, ["activity-log:verbose"]);
  assert.deepEqual(noWindow.win.added, []);

  const noDocument = createWorld({
    doubles: createTauri().doubles,
    window: createFakeWindow(),
  }).load(SINK_PATH);
  assert.doesNotThrow(() => noDocument.startActivitySink());
});

for (const [label, fail] of [
  ["rejects", async () => Promise.reject(new Error("backend down"))],
  [
    "throws synchronously",
    () => {
      throw new Error("backend down");
    },
  ],
]) {
  test(`sink: a backend that ${label} never reaches the caller, the console or the rejection handler`, async (t) => {
    const rejections = watchUnhandledRejections(t);
    const h = createSinkSingleton(t);
    h.tauri.state.respond = fail;
    h.tauri.state.listenFails = true;
    assert.doesNotThrow(() => h.logActivity("error", "app", "first"));
    h.clock.tick(250);
    await settle();
    await h.flushActivity();
    await settle();
    assert.equal(h.tauri.sent().length, 1, "the batch was attempted");
    assert.equal(h.console.calls.length, 0, "the sink never reports through console.*");
    assert.deepEqual(rejections, []);
  });
}

test("sink: a failed initial info request does not stop batches from being sent", async (t) => {
  const h = createSinkSingleton(t);
  h.tauri.state.respond = async (command) => {
    if (command === "get_activity_log_info") throw new Error("not ready");
    return { verbose: true };
  };
  h.logActivity("info", "app", "kept");
  h.clock.tick(250);
  await settle();
  assert.deepEqual(h.tauri.sent().map(messagesOf), [["kept"]]);
  assert.equal(h.isActivityVerbose(), true);
});

// ---------------------------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------------------------

// A console whose methods remember `this`, their arguments and (optionally) the call order.
function createTargetConsole(order) {
  const calls = [];
  const target = { calls };
  for (const method of CONSOLE_METHODS) {
    target[method] = function (...args) {
      order?.push("previous");
      calls.push({ method, args, self: this });
    };
  }
  return target;
}

function createConsoleCapture({ verbose = false, order } = {}) {
  const recorder = createRecorder({ verbose, order });
  const world = createWorld({ overrides: { [SINK_PATH]: recorder.module } });
  return {
    ...world.load("src/utils/activityConsole.ts"),
    recorder,
    entries: recorder.entries,
    world,
  };
}

const messagesFrom = (entries) => entries.map((entry) => entry.message);

test("console: error, warn, info and log/debug become error, warn, info and debug entries", () => {
  const h = createConsoleCapture({ verbose: true });
  const target = createTargetConsole();
  h.installConsoleCapture(target);
  target.error("e");
  target.warn("w");
  target.info("i");
  target.log("l");
  target.debug("d");
  assert.deepEqual(h.entries, [
    { level: "error", category: "app", message: "e" },
    { level: "warn", category: "app", message: "w" },
    { level: "info", category: "app", message: "i" },
    { level: "debug", category: "app", message: "l" },
    { level: "debug", category: "app", message: "d" },
  ]);
});

test("console: debug lines are skipped before they are rendered while Verbose is off", () => {
  const h = createConsoleCapture({ verbose: false });
  const target = createTargetConsole();
  h.installConsoleCapture(target);
  let rendered = 0;
  const expensive = {
    toJSON() {
      rendered += 1;
      return "x";
    },
  };

  target.log("chatty", expensive);
  target.debug("chattier", expensive);
  assert.equal(rendered, 0, "nothing is stringified for a line that would be dropped");
  assert.deepEqual(h.entries, []);
  assert.equal(target.calls.length, 2, "the original console still receives every call");

  target.error("loud", expensive);
  assert.equal(rendered, 1);
  assert.deepEqual(h.entries, [{ level: "error", category: "app", message: 'loud "x"' }]);

  h.recorder.state.verbose = true;
  target.log("now chatty", expensive);
  assert.deepEqual(messagesFrom(h.entries), ['loud "x"', 'now chatty "x"']);
});

test("console: the category is the first segment of a leading [tag]", () => {
  const { consoleCategory } = createConsoleCapture();
  const cases = [
    ["[sync.prepare] scanning", "sync"],
    ["[shortcuts] ready", "shortcuts"],
    ["[OAuth:UI:Callback] opened", "oauth"],
    ["  [Toasts] leading spaces", "toasts"],
    ["[sync-status] a hyphen stays", "sync-status"],
    ["no tag at all", "app"],
    ["text [not.leading] tag", "app"],
    ["[session] is reserved for Rust", "app"],
    ["[Session.start] is reserved too", "app"],
    ["[] empty", "app"],
    ["[1bad] must start with a letter", "app"],
    ["[a b] no spaces", "app"],
    ["", "app"],
    [`[${"x".repeat(40)}] long tag`, "x".repeat(24)],
    [`[${"y".repeat(65)}] too long to be a tag`, "app"],
  ];
  for (const [message, expected] of cases) {
    assert.equal(consoleCategory(message), expected, JSON.stringify(message));
  }
});

test("console: the tag decides the category of the recorded entry", () => {
  const h = createConsoleCapture({ verbose: true });
  const target = createTargetConsole();
  h.installConsoleCapture(target);
  target.error("[sync.prepare] failed", { page: 2 });
  target.warn("[Session] sneaky");
  assert.deepEqual(h.entries, [
    { level: "error", category: "sync", message: '[sync.prepare] failed {"page":2}' },
    { level: "warn", category: "app", message: "[Session] sneaky" },
  ]);
});

test("console: arguments are rendered like the file logger and joined with a space", () => {
  const h = createConsoleCapture({ verbose: true });
  const { stringifyArg } = h.world.load("src/utils/stringifyArg.ts");
  const target = createTargetConsole();
  h.installConsoleCapture(target);
  const error = new Error("disk full");
  error.stack = "Error: disk full\n    at save (app.js:1:1)";

  target.warn("[sync] failed", { page: 2 }, [1, 2], null, 7, true);
  target.info("value:", undefined);
  target.error(error);
  assert.deepEqual(h.entries, [
    { level: "warn", category: "sync", message: '[sync] failed {"page":2} [1,2] null 7 true' },
    { level: "info", category: "app", message: "value: undefined" },
    { level: "error", category: "app", message: stringifyArg(error) },
  ]);
  assert.match(h.entries[2].message, /disk full[\s\S]*at save \(app\.js:1:1\)/);
});

test("console: the previous implementation runs first, on the same console, with the same arguments", () => {
  const order = [];
  const h = createConsoleCapture({ verbose: true, order });
  const target = createTargetConsole(order);
  h.installConsoleCapture(target);
  const arg = { a: 1 };
  target.warn("hello", arg);
  assert.deepEqual(order, ["previous", "record"]);
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0].self, target);
  assert.equal(target.calls[0].args[1], arg, "arguments are passed on by identity");
});

test("console: a previous implementation that throws is still recorded and its error propagates", () => {
  const h = createConsoleCapture({ verbose: true });
  const target = createTargetConsole();
  const boom = new Error("log file closed");
  target.error = () => {
    throw boom;
  };
  h.installConsoleCapture(target);
  assert.throws(
    () => target.error("[sync] lost"),
    (thrown) => thrown === boom,
  );
  assert.deepEqual(h.entries, [{ level: "error", category: "sync", message: "[sync] lost" }]);
});

test("console: it chains over a console that the file logger already patched", () => {
  const order = [];
  const h = createConsoleCapture({ verbose: true, order });
  const target = createTargetConsole();
  for (const method of CONSOLE_METHODS) {
    const original = target[method];
    target[method] = (...args) => {
      order.push("file-logger");
      original.apply(target, args);
    };
  }
  h.installConsoleCapture(target);
  target.error("[sync] boom");
  target.debug("details");
  assert.deepEqual(order, ["file-logger", "record", "file-logger", "record"]);
  assert.deepEqual(
    target.calls.map((call) => call.method),
    ["error", "debug"],
    "the file logger's own target is still reached",
  );
});

test("console: installing twice wraps once, even from another copy of the module", () => {
  const target = createTargetConsole();
  const first = createConsoleCapture({ verbose: true });
  first.installConsoleCapture(target);
  const wrapped = target.error;
  first.installConsoleCapture(target);
  assert.equal(target.error, wrapped);
  target.error("once");
  assert.equal(first.entries.length, 1);

  const second = createConsoleCapture({ verbose: true });
  second.installConsoleCapture(target);
  assert.equal(target.error, wrapped, "a re-evaluated module keeps the first wrapper");
  target.error("still once");
  assert.equal(first.entries.length, 2);
  assert.equal(second.entries.length, 0);
});

test("console: something logged while recording is not recorded again", () => {
  const h = createConsoleCapture({ verbose: true });
  const target = createTargetConsole();
  h.installConsoleCapture(target);
  let nested = 0;
  h.recorder.state.onLog = () => {
    nested += 1;
    target.error("nested");
  };
  target.error("outer");
  assert.deepEqual(messagesFrom(h.entries), ["outer"]);
  assert.equal(nested, 1);
  assert.deepEqual(
    target.calls.map((call) => call.args[0]),
    ["outer", "nested"],
    "the nested call still reaches the real console",
  );

  h.recorder.state.onLog = undefined;
  target.error("later");
  assert.deepEqual(messagesFrom(h.entries), ["outer", "later"]);
});

test("console: a failing log never reaches the caller and later calls are still captured", () => {
  const h = createConsoleCapture({ verbose: true });
  const target = createTargetConsole();
  h.installConsoleCapture(target);
  h.recorder.state.throwOnLog = true;
  assert.doesNotThrow(() => target.error("lost"));
  h.recorder.state.throwOnLog = false;
  target.error("kept");
  assert.deepEqual(messagesFrom(h.entries), ["kept"]);
  assert.equal(target.calls.length, 2);
});

test("console: arguments that cannot be printed do not break capture", () => {
  const h = createConsoleCapture({ verbose: true });
  const target = createTargetConsole();
  h.installConsoleCapture(target);
  const hostile = {
    toJSON() {
      throw new Error("no json");
    },
    toString() {
      throw new Error("no string");
    },
  };
  const circular = {};
  circular.self = circular;
  target.warn("[sync] bad", hostile);
  target.warn("[sync] loop", circular);
  assert.deepEqual(messagesFrom(h.entries), [
    "[sync] bad <unprintable>",
    "[sync] loop [object Object]",
  ]);
});

test("console: the toast echo is skipped, other toast messages are recorded", () => {
  const h = createConsoleCapture({ verbose: true });
  const target = createTargetConsole();
  h.installConsoleCapture(target);
  target.info("[toasts] push", { kind: "error", key: "asset.deleteFailed", count: 1 });
  target.info("[toasts] event bridge started", { events: 2 });
  assert.deepEqual(h.entries, [
    { level: "info", category: "toasts", message: '[toasts] event bridge started {"events":2}' },
  ]);
  assert.equal(target.calls.length, 2);
});

test("console: output without any text is not recorded", () => {
  const h = createConsoleCapture({ verbose: true });
  const target = createTargetConsole();
  h.installConsoleCapture(target);
  target.info();
  target.info("");
  target.warn("   ", "\n");
  assert.deepEqual(h.entries, []);
  assert.equal(target.calls.length, 3);
});

test("console: a console with missing or locked methods is tolerated", () => {
  const h = createConsoleCapture({ verbose: true });
  const seen = [];
  const partial = { error: (...args) => seen.push(args) };
  assert.doesNotThrow(() => h.installConsoleCapture(partial));
  assert.equal(partial.warn, undefined);
  partial.error("[sync] partial");
  assert.deepEqual(messagesFrom(h.entries), ["[sync] partial"]);
  assert.equal(seen.length, 1);

  const locked = createTargetConsole();
  const calls = locked.calls;
  const frozen = Object.freeze(locked);
  assert.doesNotThrow(() => h.installConsoleCapture(frozen));
  frozen.error("[sync] locked");
  assert.equal(calls.length, 1, "the original console keeps working");
  assert.deepEqual(messagesFrom(h.entries), ["[sync] partial"], "and is not captured");
});

// ---------------------------------------------------------------------------------------------
// Uncaught errors and unhandled rejections
// ---------------------------------------------------------------------------------------------

function createWindowErrorCapture({ verbose = false } = {}) {
  const recorder = createRecorder({ verbose });
  const tauri = createTauri();
  const world = createWorld({
    overrides: { [SINK_PATH]: recorder.module },
    doubles: tauri.doubles,
  });
  return {
    ...world.load("src/utils/activityWindowErrors.ts"),
    recorder,
    entries: recorder.entries,
    tauri,
    world,
  };
}

const errorEvent = (init) => Object.assign(new Event("error"), init);
const rejectionEvent = (reason) => Object.assign(new Event("unhandledrejection"), { reason });

test("window errors: an uncaught error reports its message and where it happened", () => {
  const { formatUncaughtError } = createWindowErrorCapture();
  const cases = [
    [
      {
        message: "Boom",
        filename: "http://localhost:1420/assets/app.js?v=3#frag",
        lineno: 3,
        colno: 9,
      },
      "uncaught error: Boom (at http://localhost:1420/assets/app.js:3:9)",
    ],
    [{ message: "Boom", filename: "app.js" }, "uncaught error: Boom (at app.js:?:?)"],
    [{ message: "Boom", filename: "" }, "uncaught error: Boom"],
    [{ message: "Boom" }, "uncaught error: Boom"],
    [{}, "uncaught error: unknown error"],
    [{ message: 42, filename: 7 }, "uncaught error: unknown error"],
    [{ message: "Script error.", error: null }, "uncaught error: Script error."],
    [{ message: "Uncaught", error: "oops" }, "uncaught error: oops"],
    [{ message: "Uncaught", error: { code: 5 } }, 'uncaught error: {"code":5}'],
  ];
  for (const [event, expected] of cases) {
    assert.equal(formatUncaughtError(event), expected);
  }
});

test("window errors: ResizeObserver notices are not application errors", () => {
  const { formatUncaughtError } = createWindowErrorCapture();
  assert.equal(formatUncaughtError({ message: "ResizeObserver loop limit exceeded" }), null);
  assert.equal(
    formatUncaughtError({
      message: "ResizeObserver loop completed with undelivered notifications.",
    }),
    null,
  );
});

test("window errors: a thrown Error contributes its stack, at most six lines of it", () => {
  const { formatUncaughtError } = createWindowErrorCapture();

  const v8 = new Error("kaboom");
  v8.stack = "Error: kaboom\n    at a (app.js:1:1)\n    at b (app.js:2:2)";
  assert.equal(
    formatUncaughtError({ message: "Uncaught Error: kaboom", error: v8 }),
    `uncaught error: ${v8.stack}`,
  );

  const deep = new Error("deep");
  const frames = Array.from(
    { length: 9 },
    (_, index) => `    at frame${index} (app.js:${index}:1)`,
  );
  deep.stack = ["Error: deep", ...frames].join("\n");
  assert.equal(
    formatUncaughtError({ error: deep }),
    `uncaught error: ${deep.stack.split("\n").slice(0, 6).join("\n")}`,
  );

  // JavaScriptCore stacks hold only the frames, so the message is added in front.
  const jsc = new Error("kaboom");
  jsc.stack = "save@http://localhost/app.js:1:2\nrun@http://localhost/app.js:3:4";
  assert.equal(formatUncaughtError({ error: jsc }), `uncaught error: Error: kaboom\n${jsc.stack}`);
});

test("window errors: messages are cut at 1200 characters", () => {
  const { formatUncaughtError, formatUnhandledRejection } = createWindowErrorCapture();
  const prefix = "uncaught error: ";
  const exact = formatUncaughtError({ message: "x".repeat(1200 - prefix.length) });
  assert.equal(exact.length, 1200);
  assert.ok(!exact.endsWith("…"));

  const over = formatUncaughtError({ message: "x".repeat(1201 - prefix.length) });
  assert.equal(over.length, 1201);
  assert.ok(over.endsWith("…"));
  assert.ok(over.startsWith("uncaught error: xxx"));

  assert.equal(formatUnhandledRejection("y".repeat(5000)).length, 1201);
});

test("window errors: an unhandled rejection is described whatever the reason is", () => {
  const { formatUnhandledRejection } = createWindowErrorCapture();
  const failure = new Error("boom");
  failure.stack = "Error: boom\n    at run (app.js:1:1)";
  const hostile = {
    toJSON() {
      throw new Error("no json");
    },
    toString() {
      throw new Error("no string");
    },
  };
  assert.equal(formatUnhandledRejection("nope"), "unhandled rejection: nope");
  assert.equal(formatUnhandledRejection({ code: 5 }), 'unhandled rejection: {"code":5}');
  assert.equal(formatUnhandledRejection(undefined), "unhandled rejection: undefined");
  assert.equal(formatUnhandledRejection(null), "unhandled rejection: null");
  assert.equal(
    formatUnhandledRejection(failure),
    "unhandled rejection: Error: boom\n    at run (app.js:1:1)",
  );
  assert.equal(formatUnhandledRejection(hostile), "unhandled rejection: <unprintable>");
});

test("window errors: the listeners record error entries and can be removed again", () => {
  const h = createWindowErrorCapture();
  const target = createFakeWindow();
  const stop = h.installWindowErrorCapture(target);
  assert.deepEqual(target.added, ["error", "unhandledrejection"]);

  target.dispatchEvent(errorEvent({ message: "Boom", filename: "app.js", lineno: 1, colno: 2 }));
  target.dispatchEvent(rejectionEvent("nope"));
  target.dispatchEvent(errorEvent({ message: "ResizeObserver loop limit exceeded" }));
  assert.deepEqual(h.entries, [
    { level: "error", category: "app", message: "uncaught error: Boom (at app.js:1:2)" },
    { level: "error", category: "app", message: "unhandled rejection: nope" },
  ]);

  stop();
  target.dispatchEvent(errorEvent({ message: "after" }));
  target.dispatchEvent(rejectionEvent("after"));
  assert.equal(h.entries.length, 2);
});

test("window errors: a rejection the invoke wrapper already logged is not logged again", async (t) => {
  const clock = useMockTimers(t);
  const h = createWindowErrorCapture();
  const { invoke } = h.world.load("src/api/invoke.ts");
  const target = createFakeWindow();
  h.installWindowErrorCapture(target);
  h.tauri.state.respond = async () => {
    throw new Error("disk full");
  };

  await assert.rejects(invoke("rename_album", { albumId: "a1" }), /disk full/);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].category, "command");

  target.dispatchEvent(rejectionEvent(new Error("disk full")));
  assert.equal(h.entries.length, 1, "another object with the same text is the same failure");

  target.dispatchEvent(rejectionEvent(new Error("something else")));
  assert.equal(h.entries.length, 2);
  assert.match(h.entries[1].message, /^unhandled rejection: Error: something else/);

  clock.tick(5001);
  target.dispatchEvent(rejectionEvent(new Error("disk full")));
  assert.equal(h.entries.length, 3, "the dedupe only covers the next few seconds");
});

test("window errors: a failing log is swallowed", async () => {
  const h = createWindowErrorCapture();
  const target = createFakeWindow();
  h.installWindowErrorCapture(target);
  h.recorder.state.throwOnLog = true;
  target.dispatchEvent(errorEvent({ message: "Boom" }));
  target.dispatchEvent(rejectionEvent("nope"));
  // A listener that threw would surface as an uncaught exception on the next tick.
  await settle();
  assert.deepEqual(h.entries, []);
});

// ---------------------------------------------------------------------------------------------
// Toast and shortcut observers
// ---------------------------------------------------------------------------------------------

function createObserverWorld() {
  const recorder = createRecorder();
  const world = createWorld({ overrides: { [SINK_PATH]: recorder.module } });
  return { recorder, entries: recorder.entries, world };
}

test("toast log: the message holds the kind and the key, plus the count of a coalesced toast", () => {
  const { world } = createObserverWorld();
  const { toastActivityMessage, toastActivityLevel } = world.load("src/utils/activityToastLog.ts");
  assert.equal(
    toastActivityMessage({ kind: "error", key: "asset.deleteFailed", count: 1 }),
    "toast error: asset.deleteFailed",
  );
  assert.equal(
    toastActivityMessage({ kind: "success", key: "album.created", count: 3 }),
    "toast success: album.created ×3",
  );
  assert.equal(
    toastActivityMessage({ kind: "info", key: "k".repeat(100), count: 1 }),
    `toast info: ${"k".repeat(80)}`,
  );
  for (const [kind, level] of [
    ["success", "info"],
    ["info", "info"],
    ["warning", "warn"],
    ["error", "warn"],
  ]) {
    assert.equal(toastActivityLevel(kind), level, kind);
  }
});

function createToastLogHarness(t) {
  const clock = useMockTimers(t);
  const observer = createObserverWorld();
  const { createToastStore } = observer.world.load("src/toasts/toastStore.ts");
  const { installToastActivityLog } = observer.world.load("src/utils/activityToastLog.ts");
  const store = createToastStore();
  const stop = installToastActivityLog(store.subscribeToEvents);
  return { ...observer, clock, store, stop };
}

test("toast log: every toast of the real store is recorded, errors and warnings as warnings", (t) => {
  const h = createToastLogHarness(t);
  h.store.push("success", "album.created");
  h.store.push("info", "sync.started");
  h.store.push("warning", "offline.queued");
  h.store.push("error", "asset.deleteFailed");
  h.store.push("error", "asset.deleteFailed", { count: 3 });
  assert.deepEqual(h.entries, [
    { level: "info", category: "ui", message: "toast success: album.created" },
    { level: "info", category: "ui", message: "toast info: sync.started" },
    { level: "warn", category: "ui", message: "toast warning: offline.queued" },
    { level: "warn", category: "ui", message: "toast error: asset.deleteFailed" },
    { level: "warn", category: "ui", message: "toast error: asset.deleteFailed ×3" },
  ]);
});

test("toast log: parameters such as album or file names never reach the log", (t) => {
  const h = createToastLogHarness(t);
  h.store.push("info", "album.renamed", { name: "Secret album name", count: 2 });
  assert.deepEqual(h.entries, [
    { level: "info", category: "ui", message: "toast info: album.renamed ×2" },
  ]);
  assert.ok(!JSON.stringify(h.entries).includes("Secret"));
});

test("toast log: unsubscribing stops the recording", (t) => {
  const h = createToastLogHarness(t);
  h.store.push("info", "first");
  h.stop();
  h.store.push("info", "second");
  assert.deepEqual(messagesFrom(h.entries), ["toast info: first"]);
});

test("toast log: a failing log never breaks the toast stack", (t) => {
  const h = createToastLogHarness(t);
  h.recorder.state.throwOnLog = true;
  assert.doesNotThrow(() => h.store.push("error", "asset.deleteFailed"));
  assert.equal(h.store.getSnapshot().length, 1, "the toast is still shown");
  assert.equal(h.world.console.calls.length, 0, "the store's own error report is not reached");
});

test("shortcut log: the message names the action and where it came from", () => {
  const { world } = createObserverWorld();
  const { shortcutActivityMessage } = world.load("src/utils/activityShortcutLog.ts");
  assert.equal(
    shortcutActivityMessage({ actionId: "photo.favorite", source: "keyboard" }),
    "action photo.favorite via keyboard",
  );
  assert.equal(
    shortcutActivityMessage({ actionId: "nav.photos", source: "menu" }),
    "action nav.photos via menu",
  );
});

function createFakeActionSource() {
  const listeners = new Set();
  return {
    listeners,
    onAction(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => [...listeners].forEach((listener) => listener(event)),
  };
}

test("shortcut log: observed actions are recorded as info entries until unsubscribed", () => {
  const { world, entries } = createObserverWorld();
  const { installShortcutActivityLog } = world.load("src/utils/activityShortcutLog.ts");
  const source = createFakeActionSource();
  const stop = installShortcutActivityLog(source);
  assert.equal(source.listeners.size, 1);

  source.emit({ actionId: "photo.delete", source: "keyboard" });
  assert.deepEqual(entries, [
    { level: "info", category: "ui", message: "action photo.delete via keyboard" },
  ]);

  stop();
  assert.equal(source.listeners.size, 0);
});

test("shortcut log: a failing log never reaches the registry", () => {
  const { world, recorder } = createObserverWorld();
  const { installShortcutActivityLog } = world.load("src/utils/activityShortcutLog.ts");
  const source = createFakeActionSource();
  installShortcutActivityLog(source);
  recorder.state.throwOnLog = true;
  assert.doesNotThrow(() => source.emit({ actionId: "photo.delete", source: "menu" }));
});

// The real registry, driven by key presses and menu dispatches.
function createShortcutHarness() {
  const { world, recorder, entries } = createObserverWorld();
  const { createShortcutRegistry } = world.load("src/shortcuts/registry.ts");
  const catalog = world.load("src/shortcuts/catalog.ts");
  const { installShortcutActivityLog } = world.load("src/utils/activityShortcutLog.ts");
  const state = { context: "browse", modal: false, time: 1000 };
  const registry = createShortcutRegistry({
    isMac: true,
    getContext: () => state.context,
    isModalOpen: () => state.modal,
    isEditableTarget: () => false,
    now: () => state.time,
  });
  const bindings = catalog.resolveBindings(null);
  const events = [];
  registry.onAction((event) => events.push(event));
  installShortcutActivityLog(registry);
  const press = (key) => {
    const keyEvent = {
      key,
      code: "",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null,
      preventDefault() {
        keyEvent.defaultPrevented = true;
      },
    };
    return registry.handleKeyDown(keyEvent, bindings);
  };
  return { world, recorder, entries, registry, state, events, press };
}

test("shortcut registry: keyboard and menu actions are reported with their source", () => {
  const h = createShortcutHarness();
  h.registry.register("photo.favorite", () => {});
  assert.equal(h.press("f"), true);
  h.state.time += 1000;
  assert.equal(h.registry.dispatch("photo.favorite"), true);
  assert.deepEqual(h.events, [
    { actionId: "photo.favorite", source: "keyboard" },
    { actionId: "photo.favorite", source: "menu" },
  ]);
  assert.deepEqual(messagesFrom(h.entries), [
    "action photo.favorite via keyboard",
    "action photo.favorite via menu",
  ]);
});

test("shortcut registry: a key press that the native menu also delivers is reported once", () => {
  const h = createShortcutHarness();
  h.registry.register("photo.favorite", () => {});
  h.press("f");
  assert.equal(h.registry.dispatch("photo.favorite"), true, "the duplicate is swallowed");
  assert.equal(h.events.length, 1);

  h.state.time += 200;
  h.registry.dispatch("photo.favorite");
  assert.equal(h.events.length, 2, "a later request is a new action");
});

test("shortcut registry: repeatable actions run but are not reported", () => {
  const h = createShortcutHarness();
  h.state.context = "viewer";
  let runs = 0;
  h.registry.register(
    "view.next",
    () => {
      runs += 1;
    },
    "viewer",
  );
  assert.equal(h.press("ArrowRight"), true);
  assert.equal(h.press("ArrowRight"), true);
  assert.equal(runs, 2);
  assert.deepEqual(h.events, []);
});

test("shortcut registry: only an action that ran is reported", () => {
  const declined = createShortcutHarness();
  declined.registry.register("photo.favorite", () => false);
  assert.equal(declined.press("f"), false);
  assert.deepEqual(declined.events, [], "nobody took the action");

  const fallback = createShortcutHarness();
  fallback.registry.register("photo.favorite", () => {});
  fallback.registry.register("photo.favorite", () => false);
  assert.equal(fallback.press("f"), true);
  assert.deepEqual(fallback.events, [{ actionId: "photo.favorite", source: "keyboard" }]);

  const blocked = createShortcutHarness();
  blocked.registry.register("photo.favorite", () => {});
  blocked.state.modal = true;
  assert.equal(blocked.press("f"), false);
  assert.equal(blocked.registry.dispatch("photo.favorite"), false);
  assert.deepEqual(blocked.events, [], "nothing runs behind an open dialog");

  const unhandled = createShortcutHarness();
  assert.equal(unhandled.registry.dispatch("photo.favorite"), false);
  assert.deepEqual(unhandled.events, []);
});

test("shortcut registry: an action whose handler throws is still reported", () => {
  const h = createShortcutHarness();
  h.registry.register("photo.favorite", () => {
    throw new Error("handler broke");
  });
  assert.equal(h.press("f"), true);
  assert.deepEqual(h.events, [{ actionId: "photo.favorite", source: "keyboard" }]);
});

test("shortcut registry: observers can leave, and a broken one does not affect the others", () => {
  const h = createShortcutHarness();
  h.registry.register("photo.favorite", () => {});
  const seen = [];
  h.registry.onAction(() => {
    throw new Error("observer broke");
  });
  const stop = h.registry.onAction((event) => seen.push(event.actionId));

  assert.doesNotThrow(() => h.press("f"));
  assert.deepEqual(seen, ["photo.favorite"]);
  assert.equal(h.entries.length, 1, "the Activity Log observer still ran");

  stop();
  h.state.time += 1000;
  h.registry.dispatch("photo.favorite");
  assert.deepEqual(seen, ["photo.favorite"]);
});

// ---------------------------------------------------------------------------------------------
// React Query failures
// ---------------------------------------------------------------------------------------------

const rq = nodeRequire("@tanstack/react-query");

function createQueryCapture() {
  const recorder = createRecorder();
  const tauri = createTauri();
  const world = createWorld({
    overrides: { [SINK_PATH]: recorder.module },
    doubles: tauri.doubles,
  });
  return {
    ...world.load("src/utils/activityQueryLog.ts"),
    invoke: world.load("src/api/invoke.ts").invoke,
    recorder,
    entries: recorder.entries,
    tauri,
    world,
  };
}

// Real timers only: React Query notifies its cache listeners from a timer.
function createQueryClient(t, { queryCache, mutationCache } = {}) {
  const client = new rq.QueryClient({
    queryCache,
    mutationCache,
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  t.after(() => client.clear());
  return client;
}

const createHandlerClient = (t, h) =>
  createQueryClient(t, {
    queryCache: new rq.QueryCache({ onError: h.logQueryFailure }),
    mutationCache: new rq.MutationCache({ onError: h.logMutationFailure }),
  });

const failQuery = (client, queryKey, error) =>
  assert.rejects(
    client.fetchQuery({
      queryKey,
      queryFn: async () => {
        throw error;
      },
    }),
    (thrown) => thrown === error,
  );

const failMutation = (client, error) =>
  assert.rejects(
    new rq.MutationObserver(client, {
      mutationFn: async () => {
        throw error;
      },
    }).mutate(),
    (thrown) => thrown === error,
  );

// Lets React Query's deferred notifications run, so "exactly once" can be asserted.
const letNotificationsRun = () => sleep(60);

test("query log: a query is named by its first key segment and nothing else of the key", () => {
  const h = createQueryCapture();
  assert.equal(
    h.queryFailureMessage(["albums", "private-album-id", { search: "Secret" }], new Error("boom")),
    "query [albums] failed: boom",
  );
  for (const queryKey of [["has space"], [123], "albums", [], undefined, [`${"x".repeat(33)}`]]) {
    assert.equal(h.queryFailureMessage(queryKey, new Error("boom")), "query [?] failed: boom");
  }
  assert.equal(
    h.queryFailureMessage(["a".repeat(32)], "text"),
    `query [${"a".repeat(32)}] failed: text`,
  );
  assert.equal(h.mutationFailureMessage("nope"), "mutation failed: nope");
  assert.equal(h.mutationFailureMessage(new Error("nope")), "mutation failed: nope");
});

test("query log: cancellations and failures the invoke wrapper already logged are not reported", async () => {
  const h = createQueryCapture();
  h.logQueryFailure(new rq.CancelledError({ silent: false }), { queryKey: ["albums"] });
  assert.deepEqual(h.entries, []);

  h.tauri.state.respond = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(h.invoke("rename_album"), /disk full/);
  assert.equal(h.entries.length, 1);

  h.logQueryFailure(new Error("disk full"), { queryKey: ["albums"] });
  h.logMutationFailure(new Error("disk full"));
  assert.equal(h.entries.length, 1, "the command failure is already in the log");

  h.logQueryFailure(new Error("other"), { queryKey: ["albums", "x"] });
  h.logMutationFailure(new Error("another"));
  assert.deepEqual(h.entries.slice(1), [
    { level: "warn", category: "query", message: "query [albums] failed: other" },
    { level: "warn", category: "query", message: "mutation failed: another" },
  ]);
});

test("query log: a client with the cache handlers reports each failure once", async (t) => {
  const h = createQueryCapture();
  const client = createHandlerClient(t, h);
  await failQuery(client, ["albums", "album-1"], new Error("boom"));
  await failMutation(client, new Error("nope"));
  await waitFor(() => h.entries.length >= 2, "both failures");
  await letNotificationsRun();
  assert.deepEqual(h.entries, [
    { level: "warn", category: "query", message: "query [albums] failed: boom" },
    { level: "warn", category: "query", message: "mutation failed: nope" },
  ]);
});

test("query log: observing a client reports each failure once, even when observed twice", async (t) => {
  const h = createQueryCapture();
  const client = createQueryClient(t);
  h.observeQueryClient(client);
  h.observeQueryClient(client);
  await failQuery(client, ["people"], new Error("boom"));
  await failMutation(client, new Error("nope"));
  await waitFor(() => h.entries.length >= 2, "both failures");
  await letNotificationsRun();
  assert.deepEqual(h.entries, [
    { level: "warn", category: "query", message: "query [people] failed: boom" },
    { level: "warn", category: "query", message: "mutation failed: nope" },
  ]);
});

test("query log: handlers and the observer together report each failure once", async (t) => {
  const h = createQueryCapture();
  const client = createHandlerClient(t, h);
  h.observeQueryClient(client);
  await failQuery(client, ["memories"], new Error("boom"));
  await failMutation(client, new Error("nope"));
  await failQuery(client, ["memories", "2"], "plain text failure");
  await failMutation(client, "plain text mutation failure");
  await waitFor(() => h.entries.length >= 4, "all failures");
  await letNotificationsRun();
  assert.deepEqual(messagesFrom(h.entries), [
    "query [memories] failed: boom",
    "mutation failed: nope",
    "query [memories] failed: plain text failure",
    "mutation failed: plain text mutation failure",
  ]);
});

test("query log: the observer covers whichever cache has no log handler of its own", async (t) => {
  const h = createQueryCapture();
  const queryHandlerOnly = createQueryClient(t, {
    queryCache: new rq.QueryCache({ onError: h.logQueryFailure }),
  });
  const mutationHandlerOnly = createQueryClient(t, {
    mutationCache: new rq.MutationCache({ onError: h.logMutationFailure }),
  });
  h.observeQueryClient(queryHandlerOnly);
  h.observeQueryClient(mutationHandlerOnly);

  await failQuery(queryHandlerOnly, ["albums"], new Error("q1"));
  await failMutation(queryHandlerOnly, new Error("m1"));
  await failQuery(mutationHandlerOnly, ["people"], new Error("q2"));
  await failMutation(mutationHandlerOnly, new Error("m2"));
  await waitFor(() => h.entries.length >= 4, "all failures");
  await letNotificationsRun();
  assert.deepEqual(messagesFrom(h.entries).sort(), [
    "mutation failed: m1",
    "mutation failed: m2",
    "query [albums] failed: q1",
    "query [people] failed: q2",
  ]);
});

test("query log: a cache with an unrelated onError handler is still observed", async (t) => {
  const h = createQueryCapture();
  const handled = [];
  const client = createQueryClient(t, {
    queryCache: new rq.QueryCache({ onError: (error) => handled.push(error) }),
    mutationCache: new rq.MutationCache({ onError: (error) => handled.push(error) }),
  });
  h.observeQueryClient(client);
  const queryError = new Error("boom");
  const mutationError = new Error("nope");
  await failQuery(client, ["albums"], queryError);
  await failMutation(client, mutationError);
  await waitFor(() => h.entries.length >= 2, "both failures");
  await letNotificationsRun();
  assert.deepEqual(handled, [queryError, mutationError], "the app's own handlers still run");
  assert.deepEqual(messagesFrom(h.entries), [
    "query [albums] failed: boom",
    "mutation failed: nope",
  ]);
});

test("query log: a cancelled query is not a failure", async (t) => {
  const h = createQueryCapture();
  const client = createHandlerClient(t, h);
  h.observeQueryClient(client);
  const pending = client.fetchQuery({ queryKey: ["albums"], queryFn: () => new Promise(() => {}) });
  const outcome = outcomeOf(pending);
  await client.cancelQueries({ queryKey: ["albums"] });
  assert.equal((await outcome).rejected, true);
  await letNotificationsRun();
  assert.deepEqual(h.entries, []);
});

for (const [label, thrown, level] of [
  ["an Error", new Error("disk full"), "error"],
  ["an offline: string", "offline: server unreachable", "warn"],
]) {
  test(`query log: a command that failed with ${label} inside a query is logged by the wrapper only`, async (t) => {
    const h = createQueryCapture();
    const client = createHandlerClient(t, h);
    h.observeQueryClient(client);
    h.tauri.state.respond = async () => {
      throw thrown;
    };

    await assert.rejects(
      client.fetchQuery({ queryKey: ["albums"], queryFn: () => h.invoke("get_albums") }),
      (error) => error === thrown,
    );
    await letNotificationsRun();
    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0].category, "command");
    assert.equal(h.entries[0].level, level);
    assert.match(h.entries[0].message, /^get_albums\(\) -> failed in \d[\d,]*ms: /);
  });
}

// ---------------------------------------------------------------------------------------------
// setupActivityCapture
// ---------------------------------------------------------------------------------------------

function createFakeQueryClient() {
  const subscriptions = { query: 0, mutation: 0 };
  const cacheFor = (name) => ({
    config: {},
    subscribe() {
      subscriptions[name] += 1;
      return () => {};
    },
  });
  const queryCache = cacheFor("query");
  const mutationCache = cacheFor("mutation");
  return {
    subscriptions,
    getQueryCache: () => queryCache,
    getMutationCache: () => mutationCache,
  };
}

// The real installer on top of the real toast store, with a fake sink, window and shortcut registry.
function createCaptureSetup({
  console: worldConsole = createConsoleSpy(),
  order,
  hasWindow = true,
} = {}) {
  const recorder = createRecorder({ order });
  const tauri = createTauri();
  const registry = createFakeActionSource();
  const worldWindow = hasWindow ? createFakeWindow() : undefined;
  const world = createWorld({
    overrides: {
      [SINK_PATH]: recorder.module,
      "src/shortcuts/shortcutRegistry.ts": { shortcutRegistry: registry },
    },
    doubles: tauri.doubles,
    console: worldConsole,
    window: worldWindow,
  });
  return {
    ...world.load("src/utils/activityCapture.ts"),
    pushToast: world.load("src/toasts/toastStore.ts").pushToast,
    recorder,
    entries: recorder.entries,
    registry,
    console: worldConsole,
    window: worldWindow,
  };
}

test("setupActivityCapture: starts the sink and feeds the log from every source", (t) => {
  useMockTimers(t);
  const h = createCaptureSetup();
  h.setupActivityCapture();
  assert.equal(h.recorder.state.started, 1);

  h.console.warn("[sync.prepare] slow page");
  h.window.dispatchEvent(errorEvent({ message: "Boom" }));
  h.window.dispatchEvent(rejectionEvent("late failure"));
  h.registry.emit({ actionId: "photo.favorite", source: "keyboard" });
  h.pushToast("error", "asset.deleteFailed");

  assert.deepEqual(h.entries, [
    { level: "warn", category: "sync", message: "[sync.prepare] slow page" },
    { level: "error", category: "app", message: "uncaught error: Boom" },
    { level: "error", category: "app", message: "unhandled rejection: late failure" },
    { level: "info", category: "ui", message: "action photo.favorite via keyboard" },
    { level: "warn", category: "ui", message: "toast error: asset.deleteFailed" },
  ]);
});

test("setupActivityCapture: calling it again installs nothing twice", (t) => {
  useMockTimers(t);
  const h = createCaptureSetup();
  h.setupActivityCapture();
  h.setupActivityCapture();
  h.setupActivityCapture({});
  assert.equal(h.recorder.state.started, 1);
  assert.deepEqual(h.window.added, ["error", "unhandledrejection"]);
  assert.equal(h.registry.listeners.size, 1);

  h.console.error("once");
  h.registry.emit({ actionId: "photo.favorite", source: "menu" });
  h.pushToast("info", "sync.started");
  assert.deepEqual(messagesFrom(h.entries), [
    "once",
    "action photo.favorite via menu",
    "toast info: sync.started",
  ]);
  assert.equal(h.console.calls.length, 1, "the console method underneath ran once");
});

test("setupActivityCapture: a console the file logger already patched is wrapped, not replaced", () => {
  const order = [];
  const patched = createTargetConsole(order);
  const h = createCaptureSetup({ console: patched, order });
  h.setupActivityCapture();

  h.console.error("[shortcuts] handler failed");
  assert.deepEqual(order, ["previous", "record"]);
  assert.equal(patched.calls.length, 1);
  assert.deepEqual(patched.calls[0].args, ["[shortcuts] handler failed"]);
  assert.deepEqual(h.entries, [
    { level: "error", category: "shortcuts", message: "[shortcuts] handler failed" },
  ]);
});

test("setupActivityCapture: each query client is observed once, whenever it is passed", () => {
  const h = createCaptureSetup();
  const first = createFakeQueryClient();
  const second = createFakeQueryClient();

  h.setupActivityCapture({ queryClient: first });
  h.setupActivityCapture({ queryClient: first });
  assert.deepEqual(first.subscriptions, { query: 1, mutation: 1 });

  h.setupActivityCapture({ queryClient: second });
  assert.deepEqual(second.subscriptions, { query: 1, mutation: 1 });
  assert.deepEqual(first.subscriptions, { query: 1, mutation: 1 });
  assert.equal(h.recorder.state.started, 1, "the global sources are still installed once");
  assert.equal(h.registry.listeners.size, 1);
});

test("setupActivityCapture: a source that fails to install does not stop the others", (t) => {
  useMockTimers(t);
  const h = createCaptureSetup();
  h.registry.onAction = () => {
    throw new Error("no shortcut registry");
  };
  assert.doesNotThrow(() => h.setupActivityCapture({ queryClient: createFakeQueryClient() }));

  h.console.warn("still captured");
  h.pushToast("info", "sync.started");
  assert.deepEqual(messagesFrom(h.entries), ["still captured", "toast info: sync.started"]);
});

test("setupActivityCapture: without a window it still captures the rest", (t) => {
  useMockTimers(t);
  const h = createCaptureSetup({ hasWindow: false });
  assert.doesNotThrow(() => h.setupActivityCapture());

  h.console.error("still captured");
  h.registry.emit({ actionId: "photo.favorite", source: "keyboard" });
  assert.deepEqual(messagesFrom(h.entries), [
    "still captured",
    "action photo.favorite via keyboard",
  ]);
});

// ---------------------------------------------------------------------------------------------
// Navigation log
// ---------------------------------------------------------------------------------------------

// A just-enough React: refs persist, effects run after a render whose dependencies changed.
function createFakeReact() {
  const slots = [];
  const queuedEffects = [];
  let cursor = 0;
  return {
    react: {
      useRef(initial) {
        const index = cursor++;
        slots[index] ??= { current: initial };
        return slots[index];
      },
      useEffect(effect, deps) {
        const index = cursor++;
        const previous = slots[index];
        const changed =
          !previous ||
          !deps ||
          deps.some((dep, position) => !Object.is(dep, previous.deps[position]));
        slots[index] = { deps };
        if (changed) queuedEffects.push(effect);
      },
    },
    // `strict` re-runs the effects the way React's StrictMode does in development.
    render(run, { strict = false } = {}) {
      cursor = 0;
      run();
      const effects = queuedEffects.splice(0);
      effects.forEach((effect) => effect());
      if (strict) effects.forEach((effect) => effect());
    },
  };
}

function createNavigationLog() {
  const recorder = createRecorder();
  const fake = createFakeReact();
  const world = createWorld({
    overrides: { [SINK_PATH]: recorder.module },
    doubles: { react: fake.react },
  });
  const { useActivityNavigationLog } = world.load("src/hooks/useActivityNavigationLog.ts");
  return {
    entries: recorder.entries,
    render: (view, options) => fake.render(() => useActivityNavigationLog(view), options),
  };
}

test("navigation log: the first view and every change of view is recorded as a ui entry", () => {
  const h = createNavigationLog();
  h.render("photos");
  h.render("photos");
  h.render("albums");
  h.render("albums");
  h.render("photos");
  assert.deepEqual(h.entries, [
    { level: "info", category: "ui", message: "navigated to photos" },
    { level: "info", category: "ui", message: "navigated to albums" },
    { level: "info", category: "ui", message: "navigated to photos" },
  ]);
});

test("navigation log: StrictMode running the effect twice does not record a view twice", () => {
  const h = createNavigationLog();
  h.render("photos", { strict: true });
  h.render("albums", { strict: true });
  assert.deepEqual(messagesFrom(h.entries), ["navigated to photos", "navigated to albums"]);
});

test("navigation log: App.tsx calls the hook exactly once, and nothing else of it", () => {
  const source = readSource("src/App.tsx");
  assert.equal(source.match(/\buseActivityNavigationLog\(\w+\);/g)?.length, 1);
  assert.equal(source.match(/from "\.\/hooks\/useActivityNavigationLog"/g)?.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Guard: the raw Tauri `invoke` stays out of the app code
// ---------------------------------------------------------------------------------------------

const TAURI_CORE = "@tauri-apps/api/core";
const RAW_INVOKE_USERS = [
  "src/api/invoke.ts",
  "src/api/activityLog.ts",
  "src/utils/activityLogSink.ts",
];

const isCoreSpecifier = (node) =>
  node !== undefined && ts.isStringLiteralLike(node) && node.text === TAURI_CORE;
const namesRawInvoke = (element) =>
  !element.isTypeOnly && (element.propertyName ?? element.name).text === "invoke";

// Describes every way `source` can reach the real `invoke`: a named import (aliased or not), a
// re-export, `invoke` read from a namespace import, or a runtime import()/require(). It reads the
// syntax tree, so type-only imports, `convertFileSrc`, `isTauri` and mentions inside comments or
// strings are not flagged.
function findRawInvokeUses(path, source) {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, kind);
  const namespaces = new Set();
  const accesses = [];
  const found = [];
  const report = (node, what) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push(`${path}:${line + 1} ${what}`);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && isCoreSpecifier(node.moduleSpecifier)) {
      const bindings = node.importClause?.isTypeOnly ? undefined : node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (namesRawInvoke(element)) report(element, "imports invoke");
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      isCoreSpecifier(node.moduleSpecifier)
    ) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          if (namesRawInvoke(element)) report(element, "re-exports invoke");
        }
      } else {
        report(node, "re-exports the whole module");
      }
    } else if (ts.isCallExpression(node) && isCoreSpecifier(node.arguments[0])) {
      const callee = node.expression;
      const isRuntimeLoad =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      if (isRuntimeLoad) report(node, "loads the module at runtime");
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      accesses.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  for (const access of accesses) {
    const member = ts.isPropertyAccessExpression(access) ? access.name : access.argumentExpression;
    const readsInvoke =
      (ts.isIdentifier(member) || ts.isStringLiteralLike(member)) && member.text === "invoke";
    if (
      readsInvoke &&
      ts.isIdentifier(access.expression) &&
      namespaces.has(access.expression.text)
    ) {
      report(access, "reads invoke from a namespace import");
    }
  }
  return found;
}

// Every source file `entry` imports, directly or through other files.
function reachableSources(entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    for (const { fileName } of ts.preProcessFile(readSource(path), true, true).importedFiles) {
      if (fileName.startsWith(".")) pending.push(resolveSource(path, fileName));
    }
  }
  return seen;
}

const sourceFiles = readdirSync(new URL("src/", repoRoot), { recursive: true })
  .map((entry) => `src/${entry.split(sep).join("/")}`)
  .filter((path) => /\.tsx?$/.test(path))
  .sort();

const RAW_INVOKE_FIXTURES = {
  "a named import": 'import { invoke } from "@tauri-apps/api/core";',
  "a named import among harmless ones":
    'import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";',
  "an aliased import": 'import { invoke as rawInvoke } from "@tauri-apps/api/core";',
  "a value import next to a type import":
    'import { type InvokeArgs, invoke } from "@tauri-apps/api/core";',
  "a single-quoted multi-line import": "import {\n  invoke,\n} from '@tauri-apps/api/core';",
  "a namespace import": 'import * as core from "@tauri-apps/api/core";\ncore.invoke("x");',
  "a namespace import and an element access":
    'import * as core from "@tauri-apps/api/core";\ncore["invoke"]("x");',
  "a re-export": 'export { invoke } from "@tauri-apps/api/core";',
  "an aliased re-export": 'export { invoke as rawInvoke } from "@tauri-apps/api/core";',
  "a star re-export": 'export * from "@tauri-apps/api/core";',
  "a namespace re-export": 'export * as core from "@tauri-apps/api/core";',
  "a dynamic import": 'async function load() { return import("@tauri-apps/api/core"); }',
  "a require call": 'const core = require("@tauri-apps/api/core");',
};

const HARMLESS_FIXTURES = {
  convertFileSrc: 'import { convertFileSrc } from "@tauri-apps/api/core";',
  isTauri: 'import { isTauri } from "@tauri-apps/api/core";',
  "a type-only import": 'import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";',
  "type-only specifiers": 'import { type invoke, type InvokeArgs } from "@tauri-apps/api/core";',
  "a type-only re-export": 'export type { InvokeArgs } from "@tauri-apps/api/core";',
  "the logging wrapper": 'import { invoke } from "../api/invoke";',
  "another Tauri module": 'import { listen } from "@tauri-apps/api/event";',
  "a namespace import used for something else":
    'import * as core from "@tauri-apps/api/core";\ncore.convertFileSrc("x");',
  "a comment":
    '// import { invoke } from "@tauri-apps/api/core";\n/* const core = require("@tauri-apps/api/core"); */',
  "a string": "const note = 'import { invoke } from \"@tauri-apps/api/core\"';",
  "other runtime imports": 'async function load() { return import("./other"); }\nrequire("other");',
  "an unrelated invoke member": "const bridge = { invoke() {} };\nbridge.invoke();",
};

test("guard scanner: every way of reaching the raw invoke is flagged", () => {
  for (const [label, source] of Object.entries(RAW_INVOKE_FIXTURES)) {
    assert.equal(findRawInvokeUses("fixture.ts", source).length, 1, label);
  }
});

test("guard scanner: harmless imports, comments and strings are not flagged", () => {
  for (const [label, source] of Object.entries(HARMLESS_FIXTURES)) {
    assert.deepEqual(findRawInvokeUses("fixture.ts", source), [], label);
  }
});

test("guard scanner: TSX files are parsed as TSX and findings name the file and line", () => {
  const view = [
    'import { convertFileSrc } from "@tauri-apps/api/core";',
    "",
    'import { invoke } from "@tauri-apps/api/core";',
    'export const View = () => <button onClick={() => invoke("x")}>{convertFileSrc("y")}</button>;',
  ].join("\n");
  assert.deepEqual(findRawInvokeUses("src/components/View.tsx", view), [
    "src/components/View.tsx:3 imports invoke",
  ]);
});

test("guard: only the logging wrapper, the activity-log API and the sink import the raw invoke", () => {
  const violations = sourceFiles
    .filter((path) => !RAW_INVOKE_USERS.includes(path))
    .flatMap((path) => findRawInvokeUses(path, readSource(path)));
  assert.deepEqual(
    violations,
    [],
    `import { invoke } from "../api/invoke" instead of the raw Tauri module:\n${violations.join("\n")}`,
  );
});

test("guard: the scan covers the whole source tree and sees the real raw imports", () => {
  assert.ok(sourceFiles.length > 100, `only ${sourceFiles.length} files were scanned`);
  for (const path of [
    "src/App.tsx",
    "src/main.tsx",
    "src/api/media.ts",
    "src/components/Layout/Header.tsx",
    "src/hooks/useSyncStatus.ts",
  ]) {
    assert.ok(sourceFiles.includes(path), `${path} is scanned`);
  }
  for (const path of ["src/api/invoke.ts", SINK_PATH]) {
    assert.equal(findRawInvokeUses(path, readSource(path)).length, 1, path);
  }
});

test("guard: convertFileSrc and type imports from the core module remain allowed", () => {
  const media = readSource("src/api/media.ts");
  assert.match(media, /import \{ convertFileSrc \} from "@tauri-apps\/api\/core"/);
  assert.deepEqual(findRawInvokeUses("src/api/media.ts", media), []);

  const factory = readSource("src/utils/activityInvoke.ts");
  assert.match(factory, /import type \{[^}]*\} from "@tauri-apps\/api\/core"/);
  assert.deepEqual(findRawInvokeUses("src/utils/activityInvoke.ts", factory), []);
});

test("guard: the sink never reaches the logging wrapper, so its own traffic cannot be logged", () => {
  const reachable = reachableSources(SINK_PATH);
  assert.ok(reachable.has("src/utils/activitySinkCore.ts"), "the walk follows relative imports");
  assert.equal(reachable.has("src/api/invoke.ts"), false);
  assert.ok(reachableSources("src/api/invoke.ts").has(SINK_PATH), "the wrapper feeds the sink");
});

// ---------------------------------------------------------------------------------------------
// The real `src/api/invoke.ts`
// ---------------------------------------------------------------------------------------------

const ACTIVITY_LOG_COMMANDS = [
  "get_activity_log_entries",
  "get_activity_log_history",
  "get_activity_log_info",
  "record_frontend_activity",
  "set_activity_log_verbose",
  "clear_activity_log",
  "open_activity_log_window",
];
const never = () => new Promise(() => {});

// `api/invoke.ts` over the Tauri doubles, with a fake clock and the sink replaced by a recorder.
function createInvokeWorld(t, respond) {
  const clock = useMockTimers(t);
  const tauri = createTauri();
  if (respond) tauri.state.respond = respond;
  const recorder = createRecorder();
  const world = createWorld({
    doubles: tauri.doubles,
    overrides: { [SINK_PATH]: recorder.module },
  });
  return { ...world.load("src/api/invoke.ts"), clock, tauri, recorder };
}

test("api/invoke: the call reaches Tauri untouched, its value comes back and one command entry is written", async (t) => {
  const reply = { renamed: true };
  const h = createInvokeWorld(t, async () => reply);
  const args = { albumId: "al-1", name: "Holiday" };
  const options = { headers: { "x-trace": "1" } };

  assert.equal(await h.invoke("rename_album", args, options), reply);

  assert.equal(h.tauri.calls.length, 1);
  assert.equal(h.tauri.calls[0].command, "rename_album");
  assert.equal(h.tauri.calls[0].args, args);
  assert.equal(h.tauri.calls[0].options, options);
  assert.equal(h.recorder.entries.length, 1);
  const [entry] = h.recorder.entries;
  assert.equal(entry.level, "info");
  assert.equal(entry.category, "command");
  assert.match(
    entry.message,
    /^rename_album\(albumId: "al-1", name: "<7 chars>"\) -> ok in \d+ms$/,
  );
  assert.equal(Number.isInteger(entry.extra.durationMs), true);
  assert.equal(entry.extra.slow, false);
});

test("api/invoke: a routine read is only written while Verbose is on", async (t) => {
  const h = createInvokeWorld(t, async () => []);
  await h.invoke("get_albums");
  assert.deepEqual(h.recorder.entries, []);

  h.recorder.state.verbose = true;
  await h.invoke("get_albums");
  assert.equal(h.recorder.entries.length, 1);
  assert.equal(h.recorder.entries[0].level, "debug");
  assert.match(h.recorder.entries[0].message, /^get_albums\(\) -> ok in \d+ms$/);
});

test("api/invoke: a failure rethrows the very same error, is logged, and callers can recognise it", async (t) => {
  const failure = new Error("album not found");
  const h = createInvokeWorld(t, async () => {
    throw failure;
  });
  assert.equal(h.wasInvokeErrorLogged(failure), false);

  const outcome = await outcomeOf(h.invoke("rename_album", { albumId: "al-1" }));

  assert.equal(outcome.rejected, true);
  assert.equal(outcome.reason, failure);
  assert.equal(h.recorder.entries.length, 1);
  const [entry] = h.recorder.entries;
  assert.equal(entry.level, "error");
  assert.equal(entry.category, "command");
  assert.match(
    entry.message,
    /^rename_album\(albumId: "al-1"\) -> failed in \d+ms: album not found$/,
  );
  assert.equal(h.wasInvokeErrorLogged(failure), true);
  assert.equal(h.wasInvokeErrorLogged("album not found"), true);
  assert.equal(h.wasInvokeErrorLogged(new Error("another failure")), false);
  assert.equal(h.wasInvokeErrorLogged(undefined), false);
});

test("api/invoke: an offline: failure is a warning and is remembered like any other", async (t) => {
  const h = createInvokeWorld(t, async () => {
    throw "offline: server unreachable";
  });

  const outcome = await outcomeOf(h.invoke("check_server_connection"));

  assert.equal(outcome.reason, "offline: server unreachable");
  assert.equal(h.recorder.entries.length, 1);
  assert.equal(h.recorder.entries[0].level, "warn");
  assert.match(
    h.recorder.entries[0].message,
    /^check_server_connection\(\) -> failed in \d+ms: offline: server unreachable$/,
  );
  assert.equal(h.wasInvokeErrorLogged("offline: server unreachable"), true);
});

test("api/invoke: a remembered failure is forgotten after 5 s", async (t) => {
  const h = createInvokeWorld(t, async () => {
    throw new Error("boom");
  });
  await outcomeOf(h.invoke("rename_album"));
  assert.equal(h.wasInvokeErrorLogged(new Error("boom")), true);

  h.clock.tick(4000);
  assert.equal(h.wasInvokeErrorLogged(new Error("boom")), true);
  h.clock.tick(1001);
  assert.equal(h.wasInvokeErrorLogged(new Error("boom")), false);
});

test("api/invoke: plugin and activity-log commands pass straight through without entries, timers or memory", async (t) => {
  const h = createInvokeWorld(t, async (command, args) => {
    if (args?.hang) return never();
    if (args?.fail) throw new Error(`${command} failed`);
    return { ok: command };
  });

  for (const command of [
    ...ACTIVITY_LOG_COMMANDS,
    "plugin:event|listen",
    "plugin:window|set_title",
  ]) {
    assert.deepEqual(await h.invoke(command), { ok: command });
    const failure = await outcomeOf(h.invoke(command, { fail: true }));
    assert.equal(failure.rejected, true, command);
    assert.equal(h.wasInvokeErrorLogged(failure.reason), false, command);
    void h.invoke(command, { hang: true });
  }
  h.clock.tick(60_000);
  await settle();

  assert.deepEqual(h.recorder.entries, []);
  assert.equal(h.tauri.calls.length, 9 * 3);
});

test("api/invoke: a call still pending after 5 s writes one warning, and finished calls leave no timer behind", async (t) => {
  const gate = deferred();
  const h = createInvokeWorld(t, async (command) =>
    command === "start_asset_sync" ? gate.promise : "done",
  );

  const pending = h.invoke("start_asset_sync", { force: true });
  await h.invoke("rename_album");
  assert.equal(h.recorder.entries.length, 1, "only the finished call has an entry so far");

  h.clock.tick(4999);
  assert.equal(h.recorder.entries.length, 1);
  h.clock.tick(1);
  assert.deepEqual(h.recorder.entries[1], {
    level: "warn",
    category: "command",
    message: "start_asset_sync(force: true) still running after 5,000ms",
  });
  h.clock.tick(60_000);
  assert.equal(h.recorder.entries.length, 2, "the warning is one-shot and rename_album has none");

  gate.resolve("finished");
  assert.equal(await pending, "finished");
  assert.equal(h.recorder.entries.length, 3);
  assert.match(h.recorder.entries[2].message, /^start_asset_sync\(force: true\) -> ok in \d+ms$/);
  h.clock.tick(60_000);
  assert.equal(h.recorder.entries.length, 3);
});

test("api/invoke: a failing logger or sink never changes the outcome of the call", async (t) => {
  const h = createInvokeWorld(t, async (command) => {
    if (command === "rename_album") throw new Error("denied");
    return "fine";
  });
  h.recorder.state.throwOnLog = true;

  assert.equal(await h.invoke("delete_asset"), "fine");
  const failure = await outcomeOf(h.invoke("rename_album"));
  assert.equal(failure.rejected, true);
  assert.equal(failure.reason.message, "denied");
  assert.equal(h.wasInvokeErrorLogged(failure.reason), true);
  assert.deepEqual(h.recorder.entries, []);
});

test("feedback loop: a command is logged once through the real sink and the sink's own traffic never comes back", async (t) => {
  const clock = useMockTimers(t);
  const tauri = createTauri();
  const world = createWorld({
    doubles: tauri.doubles,
    window: createFakeWindow(),
    document: createFakeDocument(),
  });
  const { invoke } = world.load("src/api/invoke.ts");
  world.load(SINK_PATH).startActivitySink();

  await invoke("rename_album", { albumId: "al-1" });
  await settle();
  assert.equal(tauri.sent().length, 0, "nothing is sent before the 250 ms window closes");
  clock.tick(250);
  await settle();

  const [batch] = tauri.sent();
  assert.equal(tauri.sent().length, 1);
  assert.equal(batch.args.entries.length, 1);
  assert.equal(batch.args.entries[0].category, "command");
  assert.match(batch.args.entries[0].message, /^rename_album\(albumId: "al-1"\) -> ok in \d+ms$/);
  assert.deepEqual(tauri.calls.map((call) => call.command).sort(), [
    "get_activity_log_info",
    "record_frontend_activity",
    "rename_album",
  ]);

  clock.tick(60_000);
  await settle();
  assert.equal(tauri.sent().length, 1, "sending the batch did not queue a new entry");
  assert.equal(tauri.calls.length, 3);
  assert.deepEqual(world.console.calls, [], "the sink stays silent on the console");
});

test("feedback loop: a failing batch is dropped quietly and does not make the wrapper log anything", async (t) => {
  const clock = useMockTimers(t);
  const tauri = createTauri();
  tauri.state.respond = async (command) => {
    if (command === "record_frontend_activity") throw new Error("backend is gone");
    return { verbose: false };
  };
  const world = createWorld({
    doubles: tauri.doubles,
    window: createFakeWindow(),
    document: createFakeDocument(),
  });
  const { invoke } = world.load("src/api/invoke.ts");
  const rejections = watchUnhandledRejections(t);
  world.load(SINK_PATH).startActivitySink();

  await invoke("rename_album");
  clock.tick(250);
  await settle();
  clock.tick(60_000);
  await settle();

  assert.equal(tauri.sent().length, 1);
  assert.equal(tauri.calls.length, 3);
  assert.deepEqual(world.console.calls, []);
  assert.deepEqual(rejections, []);
});
