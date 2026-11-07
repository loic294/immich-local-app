import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compiled = new Map();

function load(path, modules, globals = {}) {
  if (!compiled.has(path)) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    compiled.set(
      path,
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText,
    );
  }
  const exports = {};
  runInNewContext(compiled.get(path), {
    exports,
    require(name) {
      assert.ok(name in modules, `Unexpected import: ${name}`);
      return modules[name];
    },
    ...globals,
  });
  return exports;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function createHarness({ mac = true, fullscreen = false, native = true } = {}) {
  let hookIndex = 0;
  const slots = [];
  const effects = [];
  const cleanups = [];
  const resizeListeners = new Set();
  const errors = [];
  let reads = 0;
  let readFullscreen = async () => fullscreen;
  let subscribe = async (listener) => {
    resizeListeners.add(listener);
    return () => resizeListeners.delete(listener);
  };
  const react = {
    useState(initial) {
      const index = hookIndex++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (value) => {
          slots[index] = typeof value === "function" ? value(slots[index]) : value;
        },
      ];
    },
    useEffect(effect) {
      const index = hookIndex++;
      if (!(index in slots)) {
        slots[index] = true;
        effects.push(effect);
      }
    },
  };
  const globals = {
    console: { info() {}, error: (...args) => errors.push(args) },
    window: { addEventListener() {}, removeEventListener() {} },
  };
  const hookModules = {
    react,
    "@tauri-apps/api/core": { isTauri: () => native },
    "@tauri-apps/api/window": {
      getCurrentWindow: () => ({
        isFullscreen() {
          reads++;
          return readFullscreen();
        },
        onResized: (listener) => subscribe(listener),
      }),
    },
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "lucide-react": {},
    "../../utils/platform": { isMacPlatform: () => mac },
    "../../hooks/useSettings": { useSettings: () => ({}) },
    "../../hooks/useRecentAlbums": { useRecentAlbums: () => ({ data: [] }) },
    "../../hooks/connectionContext": {
      useConnectionContext: () => ({ isOnline: true, pendingCount: 0 }),
    },
    "../../i18n": { useI18n: () => ({ t: (key) => key }) },
    "../../i18n/browsing": { useBrowsingI18n: () => (key) => key },
    "./SidebarButton": { SidebarButton: "SidebarButton" },
    "./SyncStatusCard": { SyncStatusCard: "SyncStatusCard" },
    "./OfflineBanner": { OfflineBanner: "OfflineBanner" },
    "../Albums/RecentAlbumsSection": { RecentAlbumsSection: "RecentAlbumsSection" },
    get "../../hooks/useWindowFullscreen"() {
      return load("../src/hooks/useWindowFullscreen.ts", hookModules, globals);
    },
  };

  return {
    errors,
    resizeListeners,
    get reads() {
      return reads;
    },
    setRead(callback) {
      readFullscreen = callback;
    },
    setSubscribe(callback) {
      subscribe = callback;
    },
    render(component = "Sidebar", props = {}) {
      hookIndex = 0;
      const exports = load(`../src/components/Layout/${component}.tsx`, modules, globals);
      const tree = exports[component]({ activePage: "photos", ...props });
      while (effects.length) {
        const cleanup = effects.shift()();
        if (cleanup) cleanups.push(cleanup);
      }
      return tree;
    },
    resize(nextFullscreen) {
      fullscreen = nextFullscreen;
      for (const listener of resizeListeners) listener();
    },
    dispose() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

function hasSpacer(node, className) {
  if (Array.isArray(node)) return node.some((child) => hasSpacer(child, className));
  if (!node?.props) return false;
  return (
    (node.props["aria-hidden"] === true && node.props.className?.split(" ").includes(className)) ||
    hasSpacer(node.props.children, className)
  );
}

test("the macOS sidebar starts at the top when the window opens in native fullscreen", async () => {
  const harness = createHarness({ fullscreen: true });
  harness.render();
  await settle();
  assert.equal(hasSpacer(harness.render(), "h-16"), false);
  harness.dispose();
});

test("the sidebar removes and restores traffic-light space on native fullscreen transitions", async () => {
  const harness = createHarness();
  harness.render();
  await settle();
  assert.equal(hasSpacer(harness.render(), "h-16"), true);
  harness.resize(true);
  await settle();
  assert.equal(hasSpacer(harness.render(), "h-16"), false);
  harness.resize(false);
  await settle();
  assert.equal(hasSpacer(harness.render(), "h-16"), true);
  harness.dispose();
});

test("the narrow header only reserves traffic-light space outside native fullscreen", async () => {
  const harness = createHarness();
  harness.render("WindowHeader");
  await settle();
  assert.equal(hasSpacer(harness.render("WindowHeader"), "w-16"), true);
  harness.resize(true);
  await settle();
  assert.equal(hasSpacer(harness.render("WindowHeader"), "w-16"), false);
  harness.resize(false);
  await settle();
  assert.equal(hasSpacer(harness.render("WindowHeader"), "w-16"), true);
  harness.dispose();
});

test("the floating drag region disappears in native fullscreen", async () => {
  const harness = createHarness();
  const render = () => harness.render("WindowHeader", { floating: true });
  render();
  await settle();
  assert.ok(render());
  harness.resize(true);
  await settle();
  assert.equal(render(), null);
  harness.resize(false);
  await settle();
  assert.ok(render());
  harness.dispose();
});

test("Windows never reserves macOS traffic-light space in either window mode", async () => {
  for (const component of ["Sidebar", "WindowHeader"]) {
    const harness = createHarness({ mac: false });
    harness.render(component);
    await settle();
    for (const fullscreen of [true, false]) {
      harness.resize(fullscreen);
      await settle();
      const tree = harness.render(component);
      assert.equal(hasSpacer(tree, "h-16"), false);
      assert.equal(hasSpacer(tree, "w-16"), false);
    }
    harness.dispose();
  }
});

test("browser previews do not call the native window API", async () => {
  const harness = createHarness({ native: false });
  harness.render();
  await settle();
  assert.equal(harness.reads, 0);
  assert.equal(harness.resizeListeners.size, 0);
  assert.equal(hasSpacer(harness.render(), "h-16"), true);
  harness.dispose();
});

test("native resize subscriptions are removed on unmount", async () => {
  const harness = createHarness();
  harness.render();
  await settle();
  assert.equal(harness.resizeListeners.size, 1);
  harness.dispose();
  assert.equal(harness.resizeListeners.size, 0);
});

test("a subscription resolving after unmount is immediately removed", async () => {
  const harness = createHarness();
  let resolveSubscription;
  let stopped = 0;
  harness.setSubscribe(
    () =>
      new Promise((resolve) => {
        resolveSubscription = resolve;
      }),
  );
  harness.render();
  harness.dispose();
  resolveSubscription(() => stopped++);
  await settle();
  assert.equal(stopped, 1);
  assert.equal(harness.reads, 0);
});

test("an older native state read cannot undo a more recent fullscreen transition", async () => {
  const harness = createHarness();
  let resolveFirst;
  harness.setRead(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  harness.render();
  await settle();
  harness.setRead(async () => true);
  harness.resize(true);
  await settle();
  assert.equal(hasSpacer(harness.render(), "h-16"), false);
  resolveFirst(false);
  await settle();
  assert.equal(hasSpacer(harness.render(), "h-16"), false);
  harness.dispose();
});

test("a native state read resolving after unmount does not update the component", async () => {
  const harness = createHarness();
  let resolveRead;
  harness.setRead(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  harness.render();
  await settle();
  harness.dispose();
  resolveRead(true);
  await settle();
  assert.equal(hasSpacer(harness.render(), "h-16"), true);
});

test("a failed native read logs the failure, preserves clearance, and can recover", async () => {
  const harness = createHarness();
  const error = new Error("native window unavailable");
  harness.setRead(async () => {
    throw error;
  });
  harness.render();
  await settle();
  assert.equal(hasSpacer(harness.render(), "h-16"), true);
  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0][0], /\[window-layout\].*fullscreen/);
  assert.equal(harness.errors[0][1], error);
  harness.setRead(async () => true);
  harness.resize(true);
  await settle();
  assert.equal(hasSpacer(harness.render(), "h-16"), false);
  harness.dispose();
});

test("a failed subscription is logged without preventing the initial fullscreen read", async () => {
  const harness = createHarness({ fullscreen: true });
  const error = new Error("resize listener unavailable");
  harness.setSubscribe(async () => {
    throw error;
  });
  harness.render();
  await settle();
  assert.equal(hasSpacer(harness.render(), "h-16"), false);
  assert.equal(harness.errors.length, 1);
  assert.match(harness.errors[0][0], /\[window-layout\].*resizing/);
  assert.equal(harness.errors[0][1], error);
  harness.dispose();
});
