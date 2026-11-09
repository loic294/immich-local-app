import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function load(path, doubles = {}) {
  const { outputText } = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  const require = (name) => {
    if (name in doubles) return doubles[name];
    assert.ok(!name.startsWith("."), `${path} imports ${name} without a test double`);
    return nodeRequire(name);
  };
  new Function("require", "module", "exports", outputText)(require, module, module.exports);
  return module.exports;
}

const storeModule = load("src/toasts/toastStore.ts");
const { createToastStore } = storeModule;

// Fake setTimeout/Date and record clearTimeout calls so a leaked timer shows up as a missing call.
function installClock(t) {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fakeClear = globalThis.clearTimeout;
  const cleared = [];
  globalThis.clearTimeout = (timer) => {
    cleared.push(timer);
    return fakeClear(timer);
  };
  t.after(() => {
    globalThis.clearTimeout = fakeClear;
    mock.timers.reset();
  });
  return { tick: (ms) => mock.timers.tick(ms), cleared };
}

function newStore(t) {
  return { store: createToastStore(), clock: installClock(t) };
}

const ids = (store) => store.getSnapshot().map((item) => item.id);
const count = (store) => store.getSnapshot().length;

test("toasts last 4 seconds, errors 6 seconds, and the stack shows at most 5", () => {
  const { durationForKind } = storeModule;
  assert.equal(storeModule.TOAST_DURATION_MS, 4000);
  assert.equal(storeModule.TOAST_ERROR_DURATION_MS, 6000);
  assert.equal(storeModule.TOAST_MAX_VISIBLE, 5);
  assert.equal(storeModule.TOAST_MIN_RESUME_MS, 1000);
  for (const kind of ["success", "info", "warning"]) assert.equal(durationForKind(kind), 4000);
  assert.equal(durationForKind("error"), 6000);
});

test("a pushed toast carries its key, params without count, count and kind duration", (t) => {
  const { store } = newStore(t);
  const renamed = store.push("success", "album.renamed", { name: "Trip" });
  const failed = store.push("error", "asset.copyFailed");
  const added = store.push("success", "album.photosAdded", { count: 4, name: "Trip" });

  assert.notEqual(renamed, failed);
  assert.deepEqual(store.getSnapshot(), [
    {
      id: renamed,
      kind: "success",
      key: "album.renamed",
      params: { name: "Trip" },
      count: 1,
      duration: 4000,
    },
    { id: failed, kind: "error", key: "asset.copyFailed", params: {}, count: 1, duration: 6000 },
    {
      id: added,
      kind: "success",
      key: "album.photosAdded",
      params: { name: "Trip" },
      count: 4,
      duration: 4000,
    },
  ]);
});

test("success, info and warning toasts disappear after exactly 4 seconds", (t) => {
  const { store, clock } = newStore(t);
  for (const kind of ["success", "info", "warning"]) {
    store.push(kind, "album.created", { name: kind });
  }
  clock.tick(3999);
  assert.equal(count(store), 3);
  clock.tick(1);
  assert.equal(count(store), 0);
});

test("error toasts stay for 6 seconds", (t) => {
  const { store, clock } = newStore(t);
  store.push("error", "asset.copyFailed");
  clock.tick(4000);
  assert.equal(count(store), 1, "still visible once a normal toast would be gone");
  clock.tick(1999);
  assert.equal(count(store), 1);
  clock.tick(1);
  assert.equal(count(store), 0);
});

test("each toast expires on its own schedule", (t) => {
  const { store, clock } = newStore(t);
  const first = store.push("success", "album.created", { name: "A" });
  clock.tick(2000);
  const second = store.push("success", "album.created", { name: "B" });
  clock.tick(2000);
  assert.deepEqual(ids(store), [second], `${first} expired at 4 s, ${second} still has 2 s`);
  clock.tick(2000);
  assert.deepEqual(ids(store), []);
});

test("repeated pushes coalesce into one counted toast and re-arm its timer", (t) => {
  const { store, clock } = newStore(t);
  const first = store.push("success", "asset.favorited");
  clock.tick(3000);
  const second = store.push("success", "asset.favorited", { count: 2 });

  assert.equal(second, first, "the existing toast is reused");
  assert.equal(count(store), 1);
  assert.equal(store.getSnapshot()[0].count, 3);

  clock.tick(3999);
  assert.equal(count(store), 1, "the timer restarted at the second push");
  clock.tick(1);
  assert.equal(count(store), 0);
  assert.equal(clock.cleared.length, 2, "re-arming cancels the previous timer, expiry the last");
});

test("coalescing needs the same kind, key and non-count params", (t) => {
  const { store } = newStore(t);
  store.push("success", "album.deleted", { name: "A" });
  store.push("success", "album.deleted", { name: "B" });
  store.push("info", "album.deleted", { name: "A" });
  store.push("success", "album.renamed", { name: "A" });
  assert.equal(count(store), 4);

  store.push("success", "album.deleted", { name: "A", count: 1 });
  assert.equal(count(store), 4);
  assert.deepEqual(
    store.getSnapshot().map((item) => item.count),
    [2, 1, 1, 1],
  );
});

test("param order and undefined params do not affect coalescing", (t) => {
  const { store } = newStore(t);
  store.push("success", "album.photosAdded", { count: 2, name: "X" });
  store.push("success", "album.photosAdded", { name: "X", count: 3 });
  store.push("success", "album.photosAdded", { count: 1, name: undefined });
  store.push("success", "album.photosAdded");

  const [named, unnamed] = store.getSnapshot();
  assert.equal(count(store), 2);
  assert.equal(named.count, 5);
  assert.equal(unnamed.count, 2);
  assert.deepEqual(unnamed.params, {});
});

test("a coalesced toast keeps its position and replaces its snapshot item", (t) => {
  const { store } = newStore(t);
  const a = store.push("success", "album.created", { name: "A" });
  const b = store.push("success", "album.created", { name: "B" });
  const before = store.getSnapshot();

  store.push("success", "album.created", { name: "A" });

  assert.deepEqual(ids(store), [a, b]);
  assert.equal(before[0].count, 1, "published items are never mutated");
  assert.equal(store.getSnapshot()[0].count, 2);
  assert.notEqual(store.getSnapshot()[0], before[0]);
  assert.equal(store.getSnapshot()[1], before[1], "untouched items keep their identity");
});

test("a counted push needs a positive finite count and floors fractions", (t) => {
  const { store } = newStore(t);
  const events = [];
  store.subscribeToEvents((event) => events.push(event));

  for (const invalid of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(store.push("success", "asset.favorited", { count: invalid }), null);
  }
  assert.equal(count(store), 0);
  assert.deepEqual(events, []);

  store.push("success", "asset.favorited", { count: 2.9 });
  assert.equal(store.getSnapshot()[0].count, 2);
});

test("a sixth toast evicts the oldest one and cancels its timer", (t) => {
  const { store, clock } = newStore(t);
  const first = store.push("info", "album.deleted", { name: "n1" });
  for (let n = 2; n <= 5; n += 1) store.push("info", "album.deleted", { name: `n${n}` });
  assert.equal(count(store), 5);
  assert.equal(clock.cleared.length, 0);

  const sixth = store.push("info", "album.deleted", { name: "n6" });

  assert.equal(count(store), 5);
  assert.ok(!ids(store).includes(first));
  assert.equal(ids(store).at(-1), sixth, "the newest toast is last, at the bottom of the stack");
  assert.deepEqual(
    store.getSnapshot().map((item) => item.params.name),
    ["n2", "n3", "n4", "n5", "n6"],
  );
  assert.equal(clock.cleared.length, 1, "the evicted toast's timer was cancelled");
});

test("a duplicate of a visible toast never evicts anything from a full stack", (t) => {
  const { store } = newStore(t);
  for (let n = 1; n <= 5; n += 1) store.push("info", "album.deleted", { name: `n${n}` });
  const before = ids(store);

  store.push("info", "album.deleted", { name: "n3" });

  assert.deepEqual(ids(store), before);
  assert.equal(store.getSnapshot()[2].count, 2);
});

test("pause freezes the countdown and resume continues with the remaining time", (t) => {
  const { store, clock } = newStore(t);
  const id = store.push("success", "album.created", { name: "A" });
  clock.tick(1000);

  store.pause(id);
  clock.tick(60_000);
  assert.equal(count(store), 1, "a paused toast never expires");

  store.resume(id);
  clock.tick(2999);
  assert.equal(count(store), 1);
  clock.tick(1);
  assert.equal(count(store), 0);
});

test("resume leaves at least one second to read the toast", (t) => {
  const { store, clock } = newStore(t);
  const id = store.push("success", "album.created", { name: "A" });
  clock.tick(3800);
  store.pause(id);
  clock.tick(5000);

  store.resume(id);
  clock.tick(999);
  assert.equal(count(store), 1);
  clock.tick(1);
  assert.equal(count(store), 0);
});

test("pause and resume ignore unknown ids and repeated calls", (t) => {
  const { store, clock } = newStore(t);
  store.pause(404);
  store.resume(404);

  const id = store.push("success", "album.created", { name: "A" });
  clock.tick(1000);
  store.pause(id);
  store.pause(id);
  clock.tick(5000);
  store.resume(id);
  clock.tick(1000);
  store.resume(id);

  clock.tick(1999);
  assert.equal(count(store), 1, "a second resume must not restart the countdown");
  clock.tick(1);
  assert.equal(count(store), 0);
});

test("a push that coalesces into a paused toast waits for resume to re-arm", (t) => {
  const { store, clock } = newStore(t);
  const id = store.push("success", "asset.favorited");
  clock.tick(1000);
  store.pause(id);

  store.push("success", "asset.favorited");
  clock.tick(60_000);
  assert.equal(count(store), 1);
  assert.equal(store.getSnapshot()[0].count, 2);

  store.resume(id);
  clock.tick(3999);
  assert.equal(count(store), 1, "the full duration applies again after the new push");
  clock.tick(1);
  assert.equal(count(store), 0);
});

test("dismiss removes the toast immediately and cancels its timer", (t) => {
  const { store, clock } = newStore(t);
  const keep = store.push("success", "album.created", { name: "keep" });
  const gone = store.push("success", "album.created", { name: "gone" });
  const calls = [];
  store.subscribe(() => calls.push(ids(store)));

  store.dismiss(gone);

  assert.deepEqual(ids(store), [keep]);
  assert.deepEqual(calls, [[keep]]);
  assert.equal(clock.cleared.length, 1);

  store.dismiss(gone);
  store.dismiss(404);
  assert.equal(calls.length, 1, "dismissing an unknown or already removed toast is silent");
});

test("clear removes every toast and timer; an empty store stays silent", (t) => {
  const { store, clock } = newStore(t);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  store.clear();
  assert.equal(notifications, 0);

  for (let n = 1; n <= 3; n += 1) store.push("info", "album.deleted", { name: `n${n}` });
  notifications = 0;
  store.clear();

  assert.equal(count(store), 0);
  assert.equal(notifications, 1);
  assert.equal(clock.cleared.length, 3);
});

test("subscribers hear every change and the snapshot is stable between changes", (t) => {
  const { store } = newStore(t);
  const seen = [];
  const stop = store.subscribe(() => seen.push(store.getSnapshot()));
  const empty = store.getSnapshot();
  assert.equal(store.getSnapshot(), empty);

  const id = store.push("success", "album.created", { name: "A" });
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], empty);
  assert.equal(store.getSnapshot(), seen[0]);

  store.pause(id);
  store.resume(id);
  assert.equal(seen.length, 1, "pausing a toast does not change what is rendered");

  stop();
  store.push("success", "album.created", { name: "B" });
  assert.equal(seen.length, 1);
});

test("toast events fire for every valid push, coalesced ones included", (t) => {
  const { store } = newStore(t);
  const events = [];
  const visibleWhenHeard = [];
  const stop = store.subscribeToEvents((event) => {
    events.push(event);
    visibleWhenHeard.push(count(store));
  });

  store.push("success", "asset.favorited", { count: 3 });
  store.push("success", "asset.favorited");
  store.push("error", "asset.favoriteFailed", { count: 2 });
  store.push("success", "asset.favorited", { count: 0 });

  assert.deepEqual(events, [
    { kind: "success", key: "asset.favorited", count: 3 },
    { kind: "success", key: "asset.favorited", count: 1 },
    { kind: "error", key: "asset.favoriteFailed", count: 2 },
  ]);
  assert.deepEqual(visibleWhenHeard, [1, 1, 2], "listeners run after the stack was updated");

  stop();
  store.push("info", "sync.upToDate");
  assert.equal(events.length, 3);
});

test("a throwing event listener cannot break the push or other listeners", (t) => {
  const { store } = newStore(t);
  t.mock.method(console, "error", () => {});
  const heard = [];
  store.subscribeToEvents(() => {
    throw new Error("boom");
  });
  store.subscribeToEvents((event) => heard.push(event.key));

  const id = store.push("info", "sync.upToDate");

  assert.equal(typeof id, "number");
  assert.deepEqual(heard, ["sync.upToDate"]);
  assert.equal(console.error.mock.callCount(), 1);
  assert.equal(console.error.mock.calls[0].arguments[0], "[toasts] event listener failed");
});

test("the module-level singleton exposes the same store behaviour", (t) => {
  const clock = installClock(t);
  const toasts = load("src/toasts/toastStore.ts");
  const events = [];
  let notifications = 0;
  toasts.subscribeToToastEvents((event) => events.push(event));
  toasts.subscribeToToasts(() => {
    notifications += 1;
  });

  const id = toasts.pushToast("success", "album.created", { name: "X" });
  assert.deepEqual(
    toasts.getToastSnapshot().map((item) => item.id),
    [id],
  );
  toasts.pauseToast(id);
  toasts.resumeToast(id);
  toasts.dismissToast(id);
  assert.equal(toasts.getToastSnapshot().length, 0);

  toasts.pushToast("info", "sync.upToDate");
  toasts.clearToasts();
  assert.equal(toasts.getToastSnapshot().length, 0);
  assert.equal(notifications, 4, "push, dismiss, push, clear");
  assert.equal(events.length, 2);
  assert.equal(clock.cleared.length, 3, "pause, dismiss and clear each cancel one timer");
});

test("the toast API forwards typed requests to the store and logs without params", (t) => {
  installClock(t);
  t.mock.method(console, "info", () => {});
  const toasts = load("src/toasts/toastStore.ts");
  const { toast } = load("src/toasts/toast.ts", { "./toastStore": toasts });

  const success = toast.success("album.created", { name: "Trip" });
  toast.info("sync.upToDate");
  toast.warning("connection.lost");
  toast.error("asset.favoriteFailed", { count: 2 });
  toast.push({ kind: "error", key: "media.error", params: { message: "secret detail" } });

  assert.deepEqual(
    toasts.getToastSnapshot().map(({ kind, key, count: n }) => [kind, key, n]),
    [
      ["success", "album.created", 1],
      ["info", "sync.upToDate", 1],
      ["warning", "connection.lost", 1],
      ["error", "asset.favoriteFailed", 2],
      ["error", "media.error", 1],
    ],
  );
  assert.equal(toasts.getToastSnapshot()[0].id, success);
  assert.deepEqual(toasts.getToastSnapshot()[0].params, { name: "Trip" });
  assert.deepEqual(
    console.info.mock.calls.at(-1).arguments,
    ["[toasts] push", { kind: "error", key: "media.error", count: 1 }],
    "params (which may hold user text) are not logged",
  );

  assert.equal(toast.success("asset.favorited", { count: 0 }), null);
  toast.dismiss(success);
  assert.ok(!toasts.getToastSnapshot().some((item) => item.id === success));
});

test("dock insets are measured from the bottom edge and the viewport clears the tallest", () => {
  const dock = load("src/toasts/dockInsetStore.ts");
  assert.equal(dock.TOAST_VIEWPORT_MARGIN_PX, 16);
  assert.equal(dock.TOAST_DOCK_GAP_PX, 8);

  assert.equal(dock.computeDockInset(800, 700), 100);
  assert.equal(dock.computeDockInset(800, 700.2), 100, "sub-pixel gaps round up");
  assert.equal(dock.computeDockInset(800, 800), 0);
  assert.equal(dock.computeDockInset(800, 900), 0, "an element below the window has no inset");
  assert.equal(dock.computeDockInset(Number.NaN, 700), 0);
  assert.equal(dock.computeDockInset(800, Number.NaN), 0);

  assert.equal(dock.computeToastViewportBottom(0), 16);
  assert.equal(dock.computeToastViewportBottom(8), 16);
  assert.equal(dock.computeToastViewportBottom(9), 17);
  assert.equal(dock.computeToastViewportBottom(100), 108);
});

test("the dock registry tracks the tallest overlay and notifies only when it changes", () => {
  const { createDockInsetRegistry } = load("src/toasts/dockInsetStore.ts");
  const registry = createDockInsetRegistry();
  const seen = [];
  const stop = registry.subscribe(() => seen.push(registry.tallest()));
  const a = registry.nextId();
  const b = registry.nextId();
  assert.notEqual(a, b);
  assert.equal(registry.tallest(), 0);

  registry.report(a, 60);
  registry.report(b, 120);
  registry.report(a, 70);
  assert.deepEqual(seen, [60, 120], "a smaller overlay changing height is not news");

  registry.report(b, 0);
  assert.deepEqual(seen, [60, 120, 70], "zero means unmounted");
  registry.report(a, Number.NaN);
  registry.report(a, -5);
  assert.deepEqual(seen, [60, 120, 70, 0]);

  stop();
  registry.report(a, 10);
  assert.equal(registry.tallest(), 10);
  assert.equal(seen.length, 4);
});

test("the shared dock registry is exposed through module-level functions", () => {
  const dock = load("src/toasts/dockInsetStore.ts");
  const seen = [];
  const stop = dock.subscribeToDockInsets(() => seen.push(dock.getTallestDockInset()));
  const id = dock.nextDockId();
  dock.reportDockInset(id, 42);
  dock.reportDockInset(id, 0);
  stop();
  assert.deepEqual(seen, [42, 0]);
});

test("deletion events become one toast per asset and time shifts one toast per batch", () => {
  const { toastForDeletionChange, toastForTimeShift } = load("src/toasts/bridgeEvents.ts");

  assert.deepEqual(toastForDeletionChange({ id: "a", isTrashed: true }), {
    kind: "success",
    key: "asset.trashed",
  });
  assert.deepEqual(toastForDeletionChange({ id: "a", isTrashed: false, isArchived: true }), {
    kind: "success",
    key: "asset.archived",
  });
  assert.deepEqual(toastForDeletionChange({ id: "a", visibility: "archive" }), {
    kind: "success",
    key: "asset.archived",
  });
  assert.deepEqual(toastForDeletionChange({ id: "a", isTrashed: false, isArchived: false }), {
    kind: "success",
    key: "asset.restored",
  });
  for (const detail of [null, undefined, "a", 3, {}, { id: 4, isTrashed: true }]) {
    assert.equal(toastForDeletionChange(detail), null);
  }

  assert.deepEqual(toastForTimeShift({ assetIds: ["a", "b", "c"], offsetSeconds: 60 }), {
    kind: "success",
    key: "asset.timeShifted",
    params: { count: 3 },
  });
  for (const detail of [null, undefined, {}, { assetIds: [] }, { assetIds: "a" }]) {
    assert.equal(toastForTimeShift(detail), null);
  }
});

test("add-to-album and new-album choices produce a success toast, nothing otherwise", () => {
  const { albumChoiceToast } = load("src/utils/albumChoiceToast.ts");
  const albums = [{ id: "a1", albumName: "Holiday" }];

  assert.deepEqual(albumChoiceToast({ albumId: "a1" }, 3, albums), {
    kind: "success",
    key: "album.photosAdded",
    params: { count: 3, name: "Holiday" },
  });
  assert.equal(albumChoiceToast({ albumId: "gone" }, 2, albums).params.name, undefined);
  assert.deepEqual(albumChoiceToast({ newAlbumName: "Trip" }, 2, albums), {
    kind: "success",
    key: "album.createdWithPhotos",
    params: { count: 2, name: "Trip" },
  });
  assert.equal(albumChoiceToast({}, 2, albums), null);
});

test("favorite batches report successes and failures separately with counts", () => {
  const { favoriteResultToasts, singleFavoriteToast } = load("src/utils/favoriteToasts.ts");

  assert.deepEqual(favoriteResultToasts(true, 3, 0), [
    { kind: "success", key: "asset.favorited", params: { count: 3 } },
  ]);
  assert.deepEqual(favoriteResultToasts(false, 3, 0), [
    { kind: "success", key: "asset.unfavorited", params: { count: 3 } },
  ]);
  assert.deepEqual(favoriteResultToasts(true, 5, 2), [
    { kind: "success", key: "asset.favorited", params: { count: 3 } },
    { kind: "error", key: "asset.favoriteFailed", params: { count: 2 } },
  ]);
  assert.deepEqual(favoriteResultToasts(false, 2, 2), [
    { kind: "error", key: "asset.unfavoriteFailed", params: { count: 2 } },
  ]);
  assert.deepEqual(favoriteResultToasts(true, 0, 0), []);

  assert.deepEqual(singleFavoriteToast(true, true), {
    kind: "success",
    key: "asset.favorited",
    params: { count: 1 },
  });
  assert.deepEqual(singleFavoriteToast(false, false), {
    kind: "error",
    key: "asset.unfavoriteFailed",
    params: { count: 1 },
  });
});

test("connection toasts fire once per transition and stay silent on the first probe", () => {
  const { connectionChangeToast } = load("src/utils/connectionToasts.ts");

  assert.equal(connectionChangeToast(null, true), null);
  assert.equal(connectionChangeToast(null, false), null);
  assert.equal(connectionChangeToast(true, true), null);
  assert.equal(connectionChangeToast(false, false, 5), null);

  assert.deepEqual(connectionChangeToast(true, false), { kind: "warning", key: "connection.lost" });
  assert.deepEqual(connectionChangeToast(true, false, 4), {
    kind: "warning",
    key: "connection.lost",
  });
  assert.deepEqual(connectionChangeToast(false, true), {
    kind: "success",
    key: "connection.restored",
  });
  assert.deepEqual(connectionChangeToast(false, true, 4), {
    kind: "success",
    key: "connection.queuedFlushed",
    params: { count: 4 },
  });
});

function loadMessages(locale = "en-CA") {
  const current = { locale };
  const module = load("src/i18n/toasts.ts", { "./index": { useI18n: () => current } });
  return { ...module, current };
}

const plain = (text) => text.replace(/[\u00a0\u202f]/g, " ");
const say = (messages, locale, key, params = {}, n = 1) =>
  plain(messages.resolveToastMessage(locale, { key, params, count: n }));

test("en-CA and fr-CA define the same toast keys and every message resolves", () => {
  const source = read("src/i18n/toasts.ts");
  const block = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
  const keysOf = (text) => [...text.matchAll(/^ {2}"([\w.]+)":/gm)].map((match) => match[1]);
  const enKeys = keysOf(block("const en = {", "} satisfies"));
  const frKeys = keysOf(block("const fr: Record", "const messages:"));
  assert.ok(enKeys.length >= 35, `expected the full toast catalogue, got ${enKeys.length}`);
  assert.deepEqual(frKeys, enKeys);
  assert.equal(new Set(enKeys).size, enKeys.length, "no duplicate keys");

  const messages = loadMessages();
  for (const locale of ["en-CA", "fr-CA"]) {
    for (const key of enKeys) {
      for (const n of [1, 3]) {
        const text = say(messages, locale, key, { name: "Holiday", message: "Boom" }, n);
        assert.ok(text.length > 0 && text !== key, `${locale} ${key} resolves`);
        if (locale === "fr-CA") assert.ok(!text.includes("'"), `${key} uses typographic ’`);
      }
    }
  }
});

test("English messages pluralise on count and quote names", () => {
  const m = loadMessages();
  assert.equal(say(m, "en-CA", "asset.favorited", {}, 1), "1 photo added to favorites");
  assert.equal(say(m, "en-CA", "asset.favorited", {}, 3), "3 photos added to favorites");
  assert.equal(
    say(m, "en-CA", "asset.favoriteFailed", {}, 2),
    "Couldn’t add 2 photos to favorites",
  );
  assert.equal(
    say(m, "en-CA", "album.photosAdded", { name: "Holiday" }, 2),
    "2 photos added to “Holiday”",
  );
  assert.equal(say(m, "en-CA", "album.photosAdded", {}, 2), "2 photos added to the album");
  assert.equal(say(m, "en-CA", "album.created", { name: "Trip" }), "Album “Trip” created");
  assert.equal(say(m, "en-CA", "media.editImported", {}, 1), "Edited photo imported");
  assert.equal(say(m, "en-CA", "media.editImported", {}, 3), "3 edited photos imported");
  assert.equal(
    say(m, "en-CA", "connection.queuedFlushed", {}, 1),
    "Back online — 1 offline change synced",
  );
  assert.equal(
    say(m, "en-CA", "connection.queuedFlushed", {}, 2),
    "Back online — 2 offline changes synced",
  );
});

test("French messages agree in number and use guillemets and typographic apostrophes", () => {
  const m = loadMessages("fr-CA");
  assert.equal(say(m, "fr-CA", "asset.favorited", {}, 1), "1 photo ajoutée aux favoris");
  assert.equal(say(m, "fr-CA", "asset.favorited", {}, 3), "3 photos ajoutées aux favoris");
  assert.equal(
    say(m, "fr-CA", "asset.favoriteFailed", {}, 1),
    "Impossible d’ajouter 1 photo aux favoris",
  );
  assert.equal(
    say(m, "fr-CA", "album.photosAdded", { name: "Holiday" }, 2),
    "2 photos ajoutées à « Holiday »",
  );
  assert.equal(say(m, "fr-CA", "album.created", { name: "Trip" }), "Album « Trip » créé");
  assert.equal(say(m, "fr-CA", "media.editImported", {}, 1), "Photo modifiée importée");
  assert.equal(say(m, "fr-CA", "media.editImported", {}, 3), "3 photos modifiées importées");
  assert.equal(
    say(m, "fr-CA", "connection.queuedFlushed", {}, 1),
    "De nouveau en ligne — 1 modification hors ligne synchronisée",
  );
  assert.equal(
    say(m, "fr-CA", "connection.queuedFlushed", {}, 2),
    "De nouveau en ligne — 2 modifications hors ligne synchronisées",
  );
});

test("message resolution prefers the toast count, passes text through and falls back to the key", () => {
  const m = loadMessages();
  assert.equal(say(m, "en-CA", "asset.archived", { count: 99 }, 2), "2 photos archived");
  assert.equal(say(m, "en-CA", "media.error", { message: "Disk full" }), "Disk full");
  assert.equal(say(m, "fr-CA", "media.error", { message: "Disque plein" }), "Disque plein");
  assert.equal(say(m, "en-CA", "not.a.key"), "not.a.key");
});

test("toast labels follow the active locale", () => {
  const m = loadMessages();
  const item = { key: "asset.favorited", params: {}, count: 2 };

  const english = m.useToastLabels();
  assert.equal(english.region, "Notifications");
  assert.equal(english.dismiss, "Dismiss notification");
  assert.equal(english.message(item), "2 photos added to favorites");

  m.current.locale = "fr-CA";
  const french = m.useToastLabels();
  assert.equal(french.dismiss, "Fermer la notification");
  assert.equal(plain(french.message(item)), "2 photos ajoutées aux favoris");
});
