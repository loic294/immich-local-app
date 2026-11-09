import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const compiled = new Map();
const noop = () => {};
// Toasts are covered by tests/toasts.test.mjs; the grid only needs them to be callable here.
const toastDouble = {
  toast: { success: noop, info: noop, warning: noop, error: noop, push: noop, dismiss: noop },
};
const favoriteToastsDouble = {
  singleFavoriteToast: () => ({ kind: "success", key: "asset.favorited" }),
};

function load(path, modules, globals) {
  if (!compiled.has(path)) {
    compiled.set(
      path,
      ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
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
    Error,
    require(name) {
      assert.ok(name in modules, `Unexpected import: ${name}`);
      return modules[name];
    },
    ...globals,
  });
  return exports;
}

function hookRuntime() {
  const slots = [];
  let cursor = 0;
  let dirty = true;
  let effects = [];
  const same = (left, right) =>
    left &&
    right &&
    left.length === right.length &&
    left.every((value, i) => Object.is(value, right[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (update) => {
          const next = typeof update === "function" ? update(slots[index]) : update;
          if (!Object.is(next, slots[index])) {
            slots[index] = next;
            dirty = true;
          }
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ??= { current: initial });
    },
    useMemo(compute, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: compute() };
      return slots[index].value;
    },
    useCallback(callback, deps) {
      return react.useMemo(() => callback, deps);
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (same(slots[index]?.deps, deps)) return;
      effects.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
    },
  };
  react.useLayoutEffect = react.useEffect;
  return {
    react,
    invalidate() {
      dirty = true;
    },
    async flush(render, commit) {
      for (let pass = 0; pass < 50; pass++) {
        if (dirty) {
          dirty = false;
          cursor = 0;
          effects = [];
          const tree = render();
          if (dirty) continue; // React retries render-phase state updates before committing.
          commit(tree);
          effects.forEach((effect) => effect());
        }
        await tick();
        if (!dirty) return;
      }
      throw new Error("Fullscreen render did not settle");
    },
  };
}

function find(tree, type, predicate = () => true) {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const result = find(child, type, predicate);
      if (result) return result;
    }
  } else if (tree?.props) {
    if (tree.type === type && predicate(tree.props)) return tree.props;
    return find(tree.props.children, type, predicate);
  }
  return null;
}

async function mountPhotos({ count = 65, mode = "archive" } = {}) {
  const runtime = hookRuntime();
  const window = new EventTarget();
  window.localStorage = { getItem: () => null, setItem() {} };
  const logs = [];
  const globals = {
    window,
    document: new EventTarget(),
    CustomEvent: class extends Event {
      constructor(type, { detail }) {
        super(type);
        this.detail = detail;
      }
    },
    performance,
    console: Object.fromEntries(
      ["log", "info", "warn", "error"].map((level) => [
        level,
        (...args) => logs.push([level, ...args]),
      ]),
    ),
  };
  let library = Array.from({ length: count }, (_, index) => ({
    id: `asset-${index}`,
    originalFileName: `photo-${index}.jpg`,
    type: "IMAGE",
    isArchived: false,
    isTrashed: false,
    visibility: "timeline",
    width: 1200,
    height: 800,
  }));
  const requests = [];
  const pendingReads = new Map();
  let searchTerm = "";
  const api = {
    async getCachedAssets(page, size) {
      requests.push(page);
      const pending = pendingReads.get(page);
      pendingReads.delete(page);
      if (pending) await pending;
      const visible = library.filter((asset) => !asset.isArchived && !asset.isTrashed);
      return {
        items: visible.slice(page * size, (page + 1) * size),
        hasNextPage: (page + 1) * size < visible.length,
      };
    },
    getSettings: async () => ({ deleteBehavior: mode }),
    refreshAsset: async (id) => library.find((asset) => asset.id === id),
    getAssetThumbnail: async (id) => `thumbnail:${id}`,
    getCachedAssetDetails: async (id) => ({ id }),
  };
  const deletion = load(
    "../src/api/deletion.ts",
    {
      "./invoke": {
        async invoke(command, { assetId }) {
          assert.equal(command, "delete_asset");
          const asset = {
            ...library.find((item) => item.id === assetId),
            ...(mode === "trash"
              ? { isTrashed: true }
              : { isArchived: true, visibility: "archive" }),
          };
          library = library.map((item) => (item.id === assetId ? asset : item));
          return asset;
        },
      },
    },
    globals,
  );
  const hooks = { react: runtime.react, "../api/tauri": api, "../api/deletion": deletion };
  const { useAssetWindow } = load("../src/hooks/useAssetWindow.ts", hooks, globals);
  const { useDeletedRefresh } = load("../src/hooks/useDeletedRefresh.ts", hooks, globals);
  const queryClient = { invalidateQueries: async () => {} };
  const query = { useQueryClient: () => queryClient, useQuery: () => ({}) };
  const externalEvents = load(
    "../src/components/PhotoGrid/usePhotoGridExternalEvents.ts",
    {
      react: runtime.react,
      "@tanstack/react-query": query,
      "../../api/media": {},
      "../../api/time": { ASSETS_TIME_SHIFTED_EVENT: "time-shifted" },
    },
    globals,
  );
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: runtime.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@tanstack/react-query": query,
    "../../api/tauri": api,
    "../../api/deletion": deletion,
    "../../i18n": { useI18n: () => ({ t: (key) => key }) },
    "../../hooks/useSettings": { useSettings: () => ({ data: { deleteBehavior: mode } }) },
    "../../toasts/toast": toastDouble,
    "../../utils/favoriteToasts": favoriteToastsDouble,
    "./photoGridUtils": {
      isVideoAsset: (asset) => asset.type === "VIDEO",
      getAssetAspectRatio: () => 1.5,
    },
    "./usePhotoGridExternalEvents": externalEvents,
    "./usePhotoGridShortcuts": { usePhotoGridShortcuts: () => {} },
    "./useSelectionFavorite": { useSelectionFavorite: () => async () => {} },
    "./usePhotoGridSelection": {
      usePhotoGridSelection: ({ displayAssets }) => ({
        selectedAssetIds: new Set(),
        assetIndexById: new Map(displayAssets.map((asset, index) => [asset.id, index])),
      }),
    },
    "./usePhotoGridVirtualLayout": {
      usePhotoGridVirtualLayout: ({ displayAssetIds }) => ({
        visibleEntries: [
          { type: "row", key: "row", items: displayAssetIds.map((id) => ({ id, width: 100 })) },
        ],
        virtualEntries: [],
        loadedTimelineMonths: [],
        loadedTimelineDays: [],
        sectionTopMap: new Map(),
        totalContentHeight: 100,
      }),
    },
  };
  for (const name of [
    "AssetThumbnail",
    "AssetPlaceholder",
    "DaySelectionCheckbox",
    "PhotoGridFullscreenOverlay",
    "VerticalTimeline",
  ]) {
    modules[`./${name}`] = { [name]: name };
  }
  modules["../Media/EditImportPill"] = { EditImportPill: "EditImportPill" };
  modules["../FixTime/FixTimeHost"] = { FixTimeHost: "FixTimeHost" };
  const { PhotoGrid } = load("../src/components/PhotoGrid/PhotoGrid.tsx", modules, globals);
  let assetWindow;
  let tree;
  const frames = [];
  const flush = () =>
    runtime.flush(
      () => {
        const refresh = useDeletedRefresh("all");
        assetWindow = useAssetWindow(true, searchTerm, String(refresh.nonce), "all");
        return PhotoGrid({
          assets: assetWindow.assets,
          isFetching: assetWindow.isFetchingNextPage,
          hasNextPage: assetWindow.hasNextPage,
          onLoadMore: assetWindow.loadNextPage,
        });
      },
      (next) => {
        tree = next;
        frames.push(find(tree, "PhotoGridFullscreenOverlay")?.activeAsset.id ?? null);
      },
    );
  await flush();
  return {
    frames,
    requests,
    logs,
    flush,
    overlay: () => find(tree, "PhotoGridFullscreenOverlay"),
    windowState: () => assetWindow,
    deferPage(page) {
      let resolve;
      let reject;
      pendingReads.set(
        page,
        new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        }),
      );
      return { resolve, reject };
    },
    async search(value) {
      searchTerm = value;
      runtime.invalidate();
      await flush();
    },
    async jump(page) {
      await assetWindow.jumpToPage(page);
      await flush();
    },
    async restore(id) {
      const asset = {
        ...library.find((item) => item.id === id),
        isArchived: false,
        isTrashed: false,
        visibility: "timeline",
      };
      library = library.map((item) => (item.id === id ? asset : item));
      window.dispatchEvent(
        new globals.CustomEvent(deletion.ASSET_DELETION_CHANGED_EVENT, { detail: asset }),
      );
      await flush();
    },
    async loadNext() {
      await assetWindow.loadNextPage();
      await flush();
    },
    async open(id) {
      const thumbnail = find(tree, "AssetThumbnail", (props) => props.asset.id === id);
      assert.ok(thumbnail, `Missing thumbnail: ${id}`);
      thumbnail.onOpen({});
      await flush();
      frames.length = 0;
    },
    async deleteActive() {
      find(tree, "PhotoGridFullscreenOverlay").onToggleArchive();
      await flush();
    },
  };
}

for (const mode of ["archive", "trash"]) {
  test(`${mode}: deleting on a later page advances without closing fullscreen during refresh`, async () => {
    const photos = await mountPhotos({ mode });
    await photos.loadNext();
    await photos.open("asset-40");
    await photos.deleteActive();
    assert.ok(photos.frames.length > 0);
    assert.ok(
      photos.frames.every((assetId) => assetId === "asset-41"),
      `Fullscreen must stay on the next media; rendered ${JSON.stringify(photos.frames)}`,
    );
  });
}

test("deleting near a page boundary keeps the next item visible", async () => {
  const photos = await mountPhotos({ count: 32 });
  await photos.loadNext();
  await photos.open("asset-30");
  await photos.deleteActive();
  assert.ok(
    photos.frames.every((assetId) => assetId === "asset-31"),
    `Fullscreen must stay mounted; rendered ${JSON.stringify(photos.frames)}`,
  );
});

test("deleting the last item shows the previous item, then closes only when empty", async () => {
  const photos = await mountPhotos({ count: 2 });
  await photos.open("asset-1");
  await photos.deleteActive();
  assert.ok(
    photos.frames.every((assetId) => assetId === "asset-0"),
    `Fullscreen must fall back to the previous item; rendered ${JSON.stringify(photos.frames)}`,
  );
  photos.frames.length = 0;
  await photos.deleteActive();
  assert.ok(photos.frames.every((assetId) => assetId === null));
  await photos.restore("asset-1");
  assert.equal(photos.overlay(), null, "an empty viewer must not reopen when items return");
});

test("a slow cached page cannot partially replace the fullscreen window", async () => {
  const photos = await mountPhotos();
  await photos.loadNext();
  await photos.open("asset-40");
  const pending = photos.deferPage(1);
  photos.requests.length = 0;
  await photos.deleteActive();
  assert.deepEqual(photos.requests, [0, 1], "refresh only the already-loaded pages");
  assert.equal(photos.windowState().assets.length, 60);
  assert.equal(photos.overlay().activeAsset.id, "asset-41");
  pending.resolve();
  await photos.flush();
  assert.ok(photos.frames.every((assetId) => assetId === "asset-41"));
});

test("a failed refresh preserves the cached window and next fullscreen item", async () => {
  const photos = await mountPhotos();
  await photos.loadNext();
  await photos.open("asset-40");
  const pending = photos.deferPage(1);
  await photos.deleteActive();
  pending.reject(new Error("cached read failed"));
  await photos.flush();
  assert.equal(photos.windowState().assets.length, 60);
  assert.match(photos.windowState().error.message, /cached read failed/);
  assert.ok(
    photos.logs.some(
      ([level, message]) => level === "warn" && message.includes("replacement failed"),
    ),
  );
  assert.ok(photos.frames.every((assetId) => assetId === "asset-41"));
});

test("deletion after a date jump refreshes that window, not the first page", async () => {
  const photos = await mountPhotos({ count: 125 });
  await photos.jump(2);
  await photos.open("asset-70");
  photos.requests.length = 0;
  await photos.deleteActive();
  assert.deepEqual(photos.requests, [2]);
  assert.equal(photos.windowState().hasPreviousPage, true);
  assert.ok(photos.frames.every((assetId) => assetId === "asset-71"));
});

test("a new search still resets pagination and supersedes a pending refresh", async () => {
  const photos = await mountPhotos();
  await photos.loadNext();
  await photos.open("asset-40");
  const pending = photos.deferPage(1);
  await photos.deleteActive();
  photos.overlay().onClose();
  await photos.flush();
  photos.requests.length = 0;
  await photos.search("new query");
  assert.deepEqual(photos.requests, [0]);
  assert.equal(photos.windowState().assets.length, 30);
  pending.resolve();
  await photos.flush();
  assert.equal(
    photos.windowState().assets.length,
    30,
    "the older refresh must not restore its pages",
  );
  assert.equal(photos.overlay(), null);
});

test("successive deletions stay on the next media even when an older refresh finishes last", async () => {
  const photos = await mountPhotos();
  await photos.loadNext();
  await photos.open("asset-40");
  const pending = photos.deferPage(1);
  await photos.deleteActive();
  photos.frames.length = 0;
  await photos.deleteActive();
  pending.resolve();
  await photos.flush();
  assert.ok(photos.frames.every((assetId) => assetId === "asset-42"));
});

test("deleting the last loaded item waits for the next page instead of selecting the previous media", async () => {
  const photos = await mountPhotos({ count: 32 });
  const pending = photos.deferPage(1);
  await photos.open("asset-29");
  await photos.deleteActive();
  pending.resolve();
  await photos.flush();
  assert.ok(
    photos.frames.every((assetId) => assetId !== null),
    "fullscreen never closes",
  );
  assert.equal(photos.overlay().activeAsset.id, "asset-30");
});
