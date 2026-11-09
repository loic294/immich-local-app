import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function load(path, doubles = {}) {
  const { outputText } = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
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

function restoreGlobal(name, previous) {
  if (previous === undefined) delete globalThis[name];
  else globalThis[name] = previous;
}

// A bare EventTarget stands in for `window` (innerHeight is settable for the dock tests).
function installWindow(t) {
  const previous = globalThis.window;
  const win = new EventTarget();
  win.innerHeight = 800;
  globalThis.window = win;
  t.after(() => restoreGlobal("window", previous));
  return win;
}

function installResizeObserver(t, enabled = true) {
  const previous = globalThis.ResizeObserver;
  const observers = [];
  if (enabled) {
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
  } else {
    delete globalThis.ResizeObserver;
  }
  t.after(() => restoreGlobal("ResizeObserver", previous));
  return observers;
}

function installClock(t) {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
}

const toastItem = (overrides = {}) => ({
  id: 7,
  kind: "success",
  key: "album.created",
  params: {},
  count: 1,
  duration: 4000,
  ...overrides,
});

function cardProps(overrides) {
  const calls = [];
  return {
    calls,
    props: {
      toast: toastItem(overrides),
      message: "Album “Trip” created",
      dismissLabel: "Dismiss notification",
      onDismiss: (id) => calls.push(["dismiss", id]),
      onPause: (id) => calls.push(["pause", id]),
      onResume: (id) => calls.push(["resume", id]),
    },
  };
}

test("a toast card is a status (alert for errors) with a kind colour and labelled dismiss button", () => {
  const { ToastCard } = load("src/components/Toasts/ToastCard.tsx");
  const render = (overrides) =>
    renderToStaticMarkup(React.createElement(ToastCard, cardProps(overrides).props));

  for (const [kind, colour, role] of [
    ["success", "alert-success", "status"],
    ["info", "alert-info", "status"],
    ["warning", "alert-warning", "status"],
    ["error", "alert-error", "alert"],
  ]) {
    const html = render({ kind });
    assert.match(html, new RegExp(`role="${role}"`), `${kind} role`);
    assert.match(html, new RegExp(`class="alert ${colour} `), `${kind} colour`);
  }

  const html = render({});
  assert.match(html, /Album “Trip” created/);
  assert.match(html, /<button[^>]*type="button"[^>]*aria-label="Dismiss notification"/);
  assert.equal(html.match(/aria-hidden="true"/g)?.length, 2, "both icons are decorative");
  for (const className of [
    "pointer-events-auto",
    "w-80",
    "max-w-[calc(100vw-2rem)]",
    "motion-reduce:animate-none",
  ]) {
    assert.ok(html.includes(className), `${className} is applied`);
  }
});

function renderInteractiveCard(overrides) {
  const { ToastCard } = load("src/components/Toasts/ToastCard.tsx", {
    react: { ...React, useRef: (initial) => ({ current: initial }) },
  });
  const { props, calls } = cardProps(overrides);
  return { element: ToastCard(props), calls };
}

test("hovering or focusing a card pauses its timer until both are gone", () => {
  const { element, calls } = renderInteractiveCard();
  const { onMouseEnter, onMouseLeave, onFocus, onBlur } = element.props;
  const focusMovesInside = { currentTarget: { contains: () => true }, relatedTarget: {} };
  const focusLeaves = { currentTarget: { contains: () => false }, relatedTarget: null };

  onMouseEnter();
  onFocus();
  assert.deepEqual(calls, [["pause", 7]], "the second trigger does not pause again");

  onMouseLeave();
  onBlur(focusMovesInside);
  assert.deepEqual(calls, [["pause", 7]], "still focused, so still paused");

  onBlur(focusLeaves);
  assert.deepEqual(calls, [
    ["pause", 7],
    ["resume", 7],
  ]);
});

test("the dismiss button closes the toast by id", () => {
  const { element, calls } = renderInteractiveCard({ id: 42 });
  const button = element.props.children[2];

  assert.equal(button.type, "button");
  assert.equal(button.props["aria-label"], "Dismiss notification");
  button.props.onClick();
  assert.deepEqual(calls, [["dismiss", 42]]);
});

const dockStore = load("src/toasts/dockInsetStore.ts");

function loadViewport({ items, tallest = 0 }) {
  const labels = {
    region: "Notifications",
    dismiss: "Dismiss notification",
    message: (item) => `${item.key} x${item.count}`,
  };
  const actions = { dismissToast() {}, pauseToast() {}, resumeToast() {} };
  const Card = function ToastCard() {
    return null;
  };
  const { ToastViewport } = load("src/components/Toasts/ToastViewport.tsx", {
    "../../i18n/toasts": { useToastLabels: () => labels },
    "../../toasts/dockInset": { useTallestDockInset: () => tallest },
    "../../toasts/dockInsetStore": dockStore,
    "../../toasts/toastStore": actions,
    "../../toasts/useToasts": { useToasts: () => items },
    "./ToastCard": { ToastCard: Card },
  });
  return { ToastViewport, labels, actions, Card };
}

test("the viewport renders nothing while there are no toasts", () => {
  assert.equal(loadViewport({ items: [] }).ToastViewport(), null);
});

test("the viewport is a labelled click-through region above the modal layers", () => {
  const region = loadViewport({ items: [toastItem()] }).ToastViewport();
  assert.equal(region.type, "section");
  assert.equal(region.props["aria-label"], "Notifications");
  const classes = region.props.className.split(" ");
  for (const className of [
    "fixed",
    "right-4",
    "z-[10100]",
    "pointer-events-none",
    "motion-reduce:transition-none",
  ]) {
    assert.ok(classes.includes(className), `${className} is applied`);
  }
});

test("the viewport keeps 1rem from the bottom unless a docked overlay needs more room", () => {
  const bottomFor = (tallest) =>
    loadViewport({ items: [toastItem()], tallest }).ToastViewport().props.style.bottom;
  assert.equal(bottomFor(0), 16);
  assert.equal(bottomFor(4), 16);
  assert.equal(bottomFor(100), 108);
});

test("the viewport lists toasts oldest first with resolved text and the store actions", () => {
  const items = [
    toastItem({ id: 1, key: "asset.favorited", count: 3 }),
    toastItem({ id: 2, kind: "error", key: "asset.copyFailed" }),
  ];
  const { ToastViewport, labels, actions, Card } = loadViewport({ items });
  const cards = ToastViewport().props.children;

  assert.deepEqual(
    cards.map((card) => card.key),
    ["1", "2"],
  );
  cards.forEach((card, index) => {
    assert.equal(card.type, Card);
    assert.equal(card.props.toast, items[index]);
    assert.equal(card.props.message, labels.message(items[index]));
    assert.equal(card.props.dismissLabel, "Dismiss notification");
    assert.equal(card.props.onDismiss, actions.dismissToast);
    assert.equal(card.props.onPause, actions.pauseToast);
    assert.equal(card.props.onResume, actions.resumeToast);
  });
});

// Minimal host for useDockInset: one slot per ref, layout effect on every render, passive once.
function createDockHost(store) {
  const slot = { current: null };
  let layout = null;
  let passive = null;
  let cleanup;
  let mounted = false;
  const dock = load("src/toasts/dockInset.ts", {
    react: {
      useRef: () => slot,
      useLayoutEffect: (effect) => {
        layout = effect;
      },
      useEffect: (effect) => {
        if (!mounted) passive = effect;
      },
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    },
    "./dockInsetStore": store,
  });
  return {
    dock,
    render(ref) {
      dock.useDockInset(ref);
      layout();
      if (!mounted) {
        mounted = true;
        cleanup = passive();
      }
    },
    unmount: () => cleanup?.(),
  };
}

const elementAt = (getTop) => ({ getBoundingClientRect: () => ({ top: getTop() }) });

test("a docked overlay reports its inset and follows layout changes and window resizes", (t) => {
  const win = installWindow(t);
  const observers = installResizeObserver(t);
  const store = load("src/toasts/dockInsetStore.ts");
  const host = createDockHost(store);
  let top = 700;
  const element = elementAt(() => top);
  const ref = { current: element };

  host.render(ref);
  assert.equal(store.getTallestDockInset(), 100);
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].observed, [element]);

  top = 650;
  observers[0].callback();
  assert.equal(store.getTallestDockInset(), 150, "the overlay grew");

  win.innerHeight = 900;
  win.dispatchEvent(new Event("resize"));
  assert.equal(store.getTallestDockInset(), 250, "the window grew");

  host.render(ref);
  assert.equal(observers.length, 1, "re-rendering the same element does not re-attach");

  host.unmount();
  assert.equal(store.getTallestDockInset(), 0, "unmounting reports 0");
  assert.equal(observers[0].disconnected, true);
  win.dispatchEvent(new Event("resize"));
  assert.equal(store.getTallestDockInset(), 0, "the resize listener was removed");
});

test("an overlay that appears or disappears between renders is registered and released", (t) => {
  installWindow(t);
  const observers = installResizeObserver(t);
  const store = load("src/toasts/dockInsetStore.ts");
  const host = createDockHost(store);
  const ref = { current: null };

  host.render(ref);
  assert.equal(store.getTallestDockInset(), 0);
  assert.equal(observers.length, 0);

  ref.current = elementAt(() => 700);
  host.render(ref);
  assert.equal(store.getTallestDockInset(), 100);

  ref.current = null;
  host.render(ref);
  assert.equal(store.getTallestDockInset(), 0);
  assert.equal(observers[0].disconnected, true);

  ref.current = elementAt(() => 740);
  host.render(ref);
  assert.equal(store.getTallestDockInset(), 60);
  assert.equal(observers.length, 2);
});

test("with several docked overlays the tallest one decides the inset", (t) => {
  installWindow(t);
  installResizeObserver(t);
  const store = load("src/toasts/dockInsetStore.ts");
  const small = createDockHost(store);
  const large = createDockHost(store);

  small.render({ current: elementAt(() => 740) });
  large.render({ current: elementAt(() => 680) });
  assert.equal(small.dock.useTallestDockInset(), 120);

  large.unmount();
  assert.equal(small.dock.useTallestDockInset(), 60);
  small.unmount();
  assert.equal(small.dock.useTallestDockInset(), 0);
});

test("without ResizeObserver the window resize listener keeps the inset fresh", (t) => {
  const win = installWindow(t);
  installResizeObserver(t, false);
  const store = load("src/toasts/dockInsetStore.ts");
  const host = createDockHost(store);

  host.render({ current: elementAt(() => 700) });
  assert.equal(store.getTallestDockInset(), 100);
  win.innerHeight = 850;
  win.dispatchEvent(new Event("resize"));
  assert.equal(store.getTallestDockInset(), 150);
});

function eventName(path, constant) {
  const match = read(path).match(new RegExp(`${constant} = "([^"]+)"`));
  assert.ok(match, `${constant} is exported from ${path}`);
  return match[1];
}

const DELETION_EVENT = eventName("src/api/deletion.ts", "ASSET_DELETION_CHANGED_EVENT");
const TIME_SHIFTED_EVENT = eventName("src/api/time.ts", "ASSETS_TIME_SHIFTED_EVENT");
const bridgeEvents = load("src/toasts/bridgeEvents.ts");

function mountBridge(t, toastDouble) {
  const win = installWindow(t);
  t.mock.method(console, "info", () => {});
  const effects = [];
  const { useToastBridge } = load("src/toasts/useToastBridge.ts", {
    react: { useEffect: (effect) => effects.push(effect) },
    "../api/deletion": { ASSET_DELETION_CHANGED_EVENT: DELETION_EVENT },
    "../api/time": { ASSETS_TIME_SHIFTED_EVENT: TIME_SHIFTED_EVENT },
    "./bridgeEvents": bridgeEvents,
    "./toast": toastDouble,
  });
  useToastBridge();
  assert.equal(effects.length, 1);
  return {
    stop: effects[0](),
    emit: (name, detail) => win.dispatchEvent(new CustomEvent(name, { detail })),
  };
}

test("the bridge turns existing window events into toasts and stops on cleanup", (t) => {
  const pushed = [];
  const { emit, stop } = mountBridge(t, { toast: { push: (request) => pushed.push(request) } });

  emit(DELETION_EVENT, { id: "a", isTrashed: true });
  emit(DELETION_EVENT, { id: "b", isTrashed: false, isArchived: true });
  emit(DELETION_EVENT, { id: "c", isTrashed: false });
  emit(DELETION_EVENT, { unrelated: true });
  emit(TIME_SHIFTED_EVENT, { assetIds: ["a", "b"], offsetSeconds: 30 });

  assert.deepEqual(pushed, [
    { kind: "success", key: "asset.trashed" },
    { kind: "success", key: "asset.archived" },
    { kind: "success", key: "asset.restored" },
    { kind: "success", key: "asset.timeShifted", params: { count: 2 } },
  ]);

  stop();
  emit(DELETION_EVENT, { id: "d", isTrashed: true });
  emit(TIME_SHIFTED_EVENT, { assetIds: ["a"], offsetSeconds: 1 });
  assert.equal(pushed.length, 4, "no listener is left behind");
});

test("a batch of deleted photos coalesces into one counted toast", (t) => {
  installClock(t);
  const store = load("src/toasts/toastStore.ts");
  t.mock.method(console, "info", () => {});
  const { toast } = load("src/toasts/toast.ts", { "./toastStore": store });
  const { emit } = mountBridge(t, { toast });

  for (const id of ["a", "b", "c"]) emit(DELETION_EVENT, { id, isTrashed: true });
  emit(DELETION_EVENT, { id: "d", isTrashed: false });

  assert.deepEqual(
    store.getToastSnapshot().map(({ key, count }) => [key, count]),
    [
      ["asset.trashed", 3],
      ["asset.restored", 1],
    ],
  );
});

// Loads the real hook with react/invoke/toast doubles. `failWith` rejects every sync action.
function mountSync(t, { previousTotal = 10, nextTotal = 10, failWith } = {}) {
  for (const method of ["info", "warn", "error"]) t.mock.method(console, method, () => {});
  const toasts = [];
  const errors = [];
  const record = (kind) => (key, params) => toasts.push([kind, key, params]);
  let states = 0;
  const { useSyncStatus } = load("src/hooks/useSyncStatus.ts", {
    react: {
      useState: (initial) =>
        states++ === 0
          ? [{ totalAssets: previousTotal }, () => {}]
          : [initial, (value) => errors.push(value)],
      useRef: (initial) => ({ current: initial }),
      useCallback: (callback) => callback,
      useEffect: () => {},
    },
    "../api/invoke": {
      invoke: async (command) => {
        if (failWith !== undefined && command !== "get_sync_status") throw failWith;
        return { totalAssets: nextTotal, checkStatus: "idle", isSyncing: false };
      },
    },
    "../toasts/toast": {
      toast: {
        success: record("success"),
        info: record("info"),
        warning: record("warning"),
        error: record("error"),
        dismiss: () => {},
      },
    },
  });
  return {
    hook: useSyncStatus(),
    toasts,
    errorMessages: () => errors.filter((value) => typeof value === "string"),
  };
}

test("a manual quick sync announces new photos or an up-to-date library", async (t) => {
  installWindow(t);
  const found = mountSync(t, { previousTotal: 10, nextTotal: 12 });
  assert.equal(await found.hook.checkForNewAssets({ announce: true }), true);
  assert.deepEqual(found.toasts, [["success", "sync.newPhotos", undefined]]);

  const unchanged = mountSync(t, { previousTotal: 10, nextTotal: 10 });
  assert.equal(await unchanged.hook.checkForNewAssets({ announce: true }), false);
  assert.deepEqual(unchanged.toasts, [["info", "sync.upToDate", undefined]]);
});

test("a manual quick sync with the server unreachable reports offline, not an error", async (t) => {
  installWindow(t);
  const sync = mountSync(t, { failWith: "offline: server unreachable" });

  assert.equal(await sync.hook.checkForNewAssets({ announce: true }), false);

  assert.deepEqual(sync.toasts, [["warning", "connection.lost", undefined]]);
  assert.deepEqual(sync.errorMessages(), []);
});

test("other quick sync failures stay in the inline error and add no toast", async (t) => {
  installWindow(t);
  const sync = mountSync(t, { failWith: new Error("boom") });

  assert.equal(await sync.hook.checkForNewAssets({ announce: true }), false);

  assert.deepEqual(sync.toasts, []);
  assert.deepEqual(sync.errorMessages(), ["boom"]);
});

test("a manual full sync announces that it started, but only when it was accepted", async (t) => {
  installWindow(t);
  const accepted = mountSync(t);
  await accepted.hook.forceFullSync({ announce: true });
  assert.deepEqual(accepted.toasts, [["info", "sync.fullStarted", undefined]]);

  const rejected = mountSync(t, { failWith: "network down" });
  await rejected.hook.forceFullSync({ announce: true });
  assert.deepEqual(rejected.toasts, []);
  assert.deepEqual(rejected.errorMessages(), ["network down"]);
});

test("automatic and unannounced sync paths never toast", async (t) => {
  installWindow(t);
  for (const scenario of [
    { previousTotal: 10, nextTotal: 12 },
    { previousTotal: 10, nextTotal: 10 },
    { failWith: "offline: server unreachable" },
    { failWith: new Error("boom") },
  ]) {
    const sync = mountSync(t, scenario);
    await sync.hook.checkForNewAssets();
    await sync.hook.forceFullSync();
    await sync.hook.startSync();
    await sync.hook.cancelSync();
    assert.deepEqual(sync.toasts, [], JSON.stringify(scenario));
  }
});

test("App mounts one toast viewport and one event bridge; every bottom-right overlay docks", () => {
  const app = read("src/App.tsx");
  assert.equal(app.match(/<ToastViewport \/>/g)?.length, 1);
  assert.equal(app.match(/useToastBridge\(\)/g)?.length, 1);
  assert.match(app, /<LocalFileApplyProgress /);

  for (const path of [
    "src/components/Layout/UpdateNotifier.tsx",
    "src/components/Layout/LocalFileApplyProgress.tsx",
    "src/components/Media/MediaWorkflow.tsx",
  ]) {
    assert.match(read(path), /useDockInset\(/, `${path} registers its dock inset`);
  }
  assert.doesNotMatch(
    read("src/components/Media/MediaWorkflow.tsx"),
    /toast toast-end/,
    "the bespoke error toast was replaced by the shared stack",
  );
});
