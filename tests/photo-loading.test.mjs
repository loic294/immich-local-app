import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as thumbhash from "thumbhash";

const require = createRequire(import.meta.url);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function loadApi(invoke) {
  const load = (path) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const exports = {};
    new Function("require", "exports", outputText)(mockRequire, exports);
    return exports;
  };
  const mockRequire = (name) => {
    if (name === "@tauri-apps/api/core") return { invoke };
    if (name === "@tauri-apps/api/webview") return {};
    if (name === "./deletion") return {};
    if (name === "./thumbnailQueue") return load("../src/api/thumbnailQueue.ts");
    return require(name);
  };
  return load("../src/api/tauri.ts");
}

test("visible album thumbnails bypass queued offscreen thumbnails", async () => {
  const started = [];
  const finish = [];
  const api = loadApi((_command, { assetId }) => {
    started.push(assetId);
    return new Promise((resolve) => finish.push(() => resolve(`data:${assetId}`)));
  });
  const offscreen = Array.from({ length: 30 }, (_, i) => api.getAssetThumbnail(`offscreen-${i}`));
  await tick();
  assert.equal(started.length, 6, "network concurrency stays bounded");
  const album = Array.from({ length: 9 }, (_, i) =>
    api.getAssetThumbnail(`album-${i}`, null, { priority: "visible" }),
  );
  const initiallyStarted = started.length;
  for (let i = 0; i < 9; i++) {
    finish.shift()();
    await tick();
  }
  const next = started.slice(initiallyStarted, initiallyStarted + 9);
  while (finish.length) {
    finish.shift()();
    await tick();
  }
  await Promise.all([...offscreen, ...album]);
  assert.deepEqual(
    next,
    Array.from({ length: 9 }, (_, i) => `album-${i}`),
  );
});

test("unmounted requests are removed, while shared requests can be promoted", async () => {
  const started = [];
  const finish = [];
  const api = loadApi((_command, { assetId }) => {
    started.push(assetId);
    return new Promise((resolve) => finish.push(() => resolve(`data:${assetId}`)));
  });
  const active = Array.from({ length: 6 }, (_, i) => api.getAssetThumbnail(`active-${i}`));
  const abandonedController = new AbortController();
  const abandoned = api.getAssetThumbnail("abandoned", null, {
    signal: abandonedController.signal,
    priority: "visible",
  });
  const abandonedResult = assert.rejects(abandoned, { name: "AbortError" });
  abandonedController.abort();

  const background = api.getAssetThumbnail("background");
  const originalController = new AbortController();
  const shared = api.getAssetThumbnail("shared", null, { signal: originalController.signal });
  const sharedResult = assert.rejects(shared, { name: "AbortError" });
  const promoted = api.getAssetThumbnail("shared", null, { priority: "visible" });
  originalController.abort();
  finish.shift()();
  await tick();
  assert.equal(started[6], "shared");
  while (finish.length) {
    finish.shift()();
    await tick();
  }
  await Promise.all([...active, background, promoted, abandonedResult, sharedResult]);
  assert.ok(!started.includes("abandoned"));
  assert.equal(started.filter((id) => id === "shared").length, 1);
  assert.equal(await api.getAssetThumbnail("shared"), "data:shared");
  assert.equal(started.filter((id) => id === "shared").length, 1, "completed data is cached");
});

test("thumbnail failures free slots and can be retried; account caches stay separate", async () => {
  let calls = 0;
  const api = loadApi(async (_command, { accountId }) => {
    if (++calls === 1) throw new Error("offline: not cached");
    return `data:${accountId}`;
  });
  await assert.rejects(api.getAssetThumbnail("photo", "one"), /offline/);
  assert.equal(await api.getAssetThumbnail("photo", "one"), "data:one");
  assert.equal(await api.getAssetThumbnail("photo", "two"), "data:two");
  assert.equal(api.isThumbnailCached("photo", "one"), "data:one");
  assert.equal(api.isThumbnailCached("photo", "two"), "data:two");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.getAssetThumbnail("photo", "one", { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(calls, 3);
});

test("the full cached layout supplies every timeline date before any scroll or pagination", () => {
  const load = (path) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const exports = {};
    new Function("require", "exports", outputText)((name) => {
      if (name === "react") return { useMemo: (calculate) => calculate() };
      if (name === "@tauri-apps/api/core") return {};
      if (name === "thumbhash") return thumbhash;
      if (name === "./photoGridUtils") return load("../src/components/PhotoGrid/photoGridUtils.ts");
      return require(name);
    }, exports);
    return exports;
  };
  const { usePhotoGridVirtualLayout } = load(
    "../src/components/PhotoGrid/usePhotoGridVirtualLayout.ts",
  );
  const full = Array.from({ length: 36 }, (_, i) => ({
    key: `${2026 - Math.floor(i / 12)}-${String(12 - (i % 12)).padStart(2, "0")}-01`,
    label: `month-${i}`,
    rows: [{ height: 210, items: [{ id: `photo-${i}`, width: 280, thumbhash: null }] }],
  }));
  const result = usePhotoGridVirtualLayout({
    fullGridSections: full,
    gridSections: full.slice(0, 1),
    displayAssetIds: ["photo-0"],
    isUsingFullLayout: true,
    viewportHeight: 600,
    scrollTop: 0,
  });
  assert.equal(result.loadedTimelineMonths.length, 36);
  assert.deepEqual(
    result.loadedTimelineDays.map((day) => day.dateKey),
    full.map((section) => section.key),
  );
  assert.equal(result.totalContentHeight, 36 * (52 + 210 + 4 + 10));
  assert.ok(
    result.visibleEntries.length < result.virtualEntries.length,
    "rendering remains virtualized",
  );
});

test("the timeline rail reserves the same width before and after cached dates arrive", () => {
  const source = readFileSync(
    new URL("../src/components/PhotoGrid/VerticalTimeline.tsx", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const exports = {};
  new Function("require", "exports", outputText)(require, exports);
  const render = (months) =>
    renderToStaticMarkup(
      React.createElement(exports.VerticalTimeline, {
        months,
        scrollRatio: 0,
        onSeekRatio() {},
        onJumpToDateKey() {},
        maxHeight: 600,
      }),
    );
  const empty = render([]);
  const populated = render([
    { monthKey: "2026-01", jumpDateKey: "2026-01-01", year: 2026, month: 1, rowCount: 1 },
  ]);
  assert.match(empty, /<aside[^>]*w-16[^>]*>/);
  assert.equal(empty.match(/class="([^"]+)"/)[1], populated.match(/class="([^"]+)"/)[1]);
});
