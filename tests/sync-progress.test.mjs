import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function renderSyncCard(preparation, overrides = {}) {
  const syncStatus = {
    isSyncing: true,
    processedAssets: 0,
    totalAssets: 1000,
    lastSyncCompletedAt: null,
    preparation,
    ...overrides,
  };
  function load(url) {
    const { outputText } = ts.transpileModule(readFileSync(url, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    const exports = {};
    const mockRequire = (name) => {
      if (name.endsWith("/useSyncStatus")) {
        return {
          useSyncStatus: () => ({
            syncStatus,
            isSyncing: true,
            progress: (syncStatus.processedAssets / syncStatus.totalAssets) * 100,
          }),
        };
      }
      if (name.endsWith("/i18n")) {
        return {
          useI18n: () => ({ t: (key, params) => `${key} ${JSON.stringify(params ?? {})}` }),
        };
      }
      if (name.startsWith(".")) return load(new URL(`${name}.tsx`, url));
      return require(name);
    };
    new Function("require", "exports", outputText)(mockRequire, exports);
    return exports;
  }
  const { SyncStatusCard } = load(
    new URL("../src/components/Layout/SyncStatusCard.tsx", import.meta.url),
  );
  return renderToStaticMarkup(React.createElement(SyncStatusCard));
}

const preparation = {
  stage: "people",
  accountIndex: 1,
  accountCount: 1,
  completedAlbums: 0,
  totalAlbums: null,
  processedAlbumAssets: 0,
  totalAlbumAssets: null,
};

test("full sync shows activity while fetching people, not a stuck zero-asset counter", () => {
  const html = renderSyncCard(preparation);
  assert.match(html, /syncCard.preparingPeople/);
  assert.doesNotMatch(html, /syncCard.syncedCount/);
  assert.doesNotMatch(html, /<progress[^>]*value=/);
});

test("album preparation advances within a large album before asset scanning begins", () => {
  const html = renderSyncCard({
    ...preparation,
    stage: "albums",
    completedAlbums: 1,
    totalAlbums: 4,
    processedAlbumAssets: 3,
    totalAlbumAssets: 6,
  });
  assert.match(html, /syncCard.preparingAlbums/);
  assert.match(html, /syncCard.preparingAlbumAssets/);
  assert.match(html, /<progress[^>]*value="37.5"/);
  assert.doesNotMatch(html, /syncCard.syncedCount/);
});

test("fetching the album list stays indeterminate and multiple accounts are identified", () => {
  const html = renderSyncCard({
    ...preparation,
    stage: "albums",
    accountIndex: 2,
    accountCount: 3,
  });
  assert.match(html, /syncCard.fetchingAlbums/);
  assert.match(html, /syncCard.preparingAccount/);
  assert.doesNotMatch(html, /<progress[^>]*value=/);
});

test("asset scanning retains the persisted count and percentage after preparation", () => {
  const html = renderSyncCard(null, { processedAssets: 300 });
  assert.match(html, /syncCard.syncedCount/);
  assert.match(html, /<progress[^>]*value="30"/);
  assert.doesNotMatch(html, /syncCard.preparing/);
});

test("empty album lists and zero-asset libraries never produce invalid percentages", () => {
  for (const html of [
    renderSyncCard({ ...preparation, stage: "albums", totalAlbums: 0 }),
    renderSyncCard(null, { totalAssets: 0 }),
  ]) {
    assert.doesNotMatch(html, /NaN|Infinity|<progress[^>]*value=/);
  }
});

test("settings and sidebar use the same progress display with both locales", () => {
  for (const path of [
    "../src/pages/SettingsPage.tsx",
    "../src/components/Layout/SyncStatusCard.tsx",
  ]) {
    assert.match(read(path), /<FullSyncProgress syncStatus=\{syncStatus\}/);
  }
  for (const key of [
    "preparingPeople",
    "fetchingAlbums",
    "preparingAlbums",
    "preparingAlbumAssets",
    "preparingAccount",
  ]) {
    assert.equal(read("../src/i18n/index.tsx").split(`${key}:`).length - 1, 2);
  }
});

test("starting or cancelling sync wakes other mounted displays without starting another sync", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const cleanups = [];
  const calls = [];
  let current = { isSyncing: false };
  const displays = [];
  const { outputText } = ts.transpileModule(read("../src/hooks/useSyncStatus.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  function mountHook() {
    const updates = [];
    displays.push(updates);
    const effects = [];
    const exports = {};
    new Function("require", "exports", outputText)((name) => {
      if (name === "react") {
        return {
          useState: (initial) => [initial, (value) => updates.push(value)],
          useRef: (initial) => ({ current: initial }),
          useCallback: (callback) => callback,
          useEffect: (effect) => effects.push(effect),
        };
      }
      if (name === "../api/invoke") {
        return {
          invoke: async (command) => {
            calls.push(command);
            return current;
          },
        };
      }
      if (name === "../toasts/toast") {
        const ignore = () => {};
        return {
          toast: { success: ignore, info: ignore, warning: ignore, error: ignore, dismiss: ignore },
        };
      }
      return require(name);
    }, exports);
    const hook = exports.useSyncStatus();
    for (const effect of effects) cleanups.push(effect());
    return hook;
  }
  try {
    const first = mountHook();
    mountHook();
    await new Promise((resolve) => setImmediate(resolve));
    current = { isSyncing: true, preparation };
    await first.forceFullSync();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(displays.every((updates) => updates.includes(current)));
    current = { isSyncing: false, preparation: null };
    await first.cancelSync();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(displays.every((updates) => updates.includes(current)));
    assert.equal(calls.filter((command) => command === "force_full_asset_sync").length, 1);
    assert.equal(calls.filter((command) => command === "cancel_asset_sync").length, 1);
    assert.ok(!calls.includes("start_asset_sync"));
  } finally {
    for (const cleanup of cleanups) cleanup?.();
    globalThis.window = previousWindow;
  }
});

test("shared sync updates do not auto-start a new full sync after explicit cancellation", () => {
  const source = ts.createSourceFile(
    "App.tsx",
    read("../src/App.tsx"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let autoStartEffect;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useEffect" &&
      node.arguments[0]?.getText(source).includes("!hasAutoStartedSync.current")
    ) {
      autoStartEffect = node.arguments[0].getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(autoStartEffect, "exercise the actual startup effect");
  let starts = 0;
  const hasAutoStartedSync = { current: false };
  const effect = new Function(
    "syncStatus",
    "hasAutoStartedSync",
    "startSync",
    `const session = {}, isRestoringSession = false, isOnline = true;
     return (${autoStartEffect})();`,
  );
  const run = (status) => effect(status, hasAutoStartedSync, () => starts++);
  run({ isSyncing: false, lastSyncCompletedAt: "previous-sync" });
  run({ isSyncing: true, lastSyncCompletedAt: null });
  run({ isSyncing: false, lastSyncCompletedAt: null });
  assert.equal(starts, 0, "observing and then cancelling a manual sync must not start another");

  hasAutoStartedSync.current = false;
  run({ isSyncing: false, lastSyncCompletedAt: null });
  run({ isSyncing: false, lastSyncCompletedAt: null });
  assert.equal(starts, 1, "first launch still automatically starts exactly one sync");
});
