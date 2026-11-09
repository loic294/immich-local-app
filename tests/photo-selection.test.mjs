import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compiled = new Map();
const jsx = (type, props) => ({ type, props });
const noop = () => {};
// Toasts are covered by tests/toasts.test.mjs; the grid only needs them to be callable here.
const toastDouble = {
  toast: { success: noop, info: noop, warning: noop, error: noop, push: noop, dismiss: noop },
};
const favoriteToastsDouble = {
  singleFavoriteToast: () => ({ kind: "success", key: "asset.favorited" }),
};
const i18n = {
  useI18n: () => ({
    t: (key, params) => (params?.name ? `${key}:${params.name}` : key),
  }),
};

function load(name, modules) {
  if (!compiled.has(name)) {
    const source = readFileSync(
      new URL(`../src/components/PhotoGrid/${name}`, import.meta.url),
      "utf8",
    );
    compiled.set(
      name,
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
  runInNewContext(compiled.get(name), {
    exports,
    console: { debug() {} },
    require(name) {
      assert.ok(name in modules, `Unexpected import: ${name}`);
      return modules[name];
    },
  });
  return exports;
}

function hookRuntime() {
  const slots = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (update) => {
          slots[index] = typeof update === "function" ? update(slots[index]) : update;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ??= { current: initial });
    },
    useMemo: (compute) => compute(),
    // Keep network, layout observers and media effects outside this interaction test.
    useEffect() {},
    useLayoutEffect() {},
  };
  return {
    react,
    render(component, props) {
      cursor = 0;
      return component(props);
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

const assets = ["IMAGE", "VIDEO", "IMAGE", "VIDEO"].map((type, index) => ({
  id: `asset-${index}`,
  originalFileName: `asset-${index}.${type === "VIDEO" ? "mp4" : "jpg"}`,
  type,
  width: 1200,
  height: 800,
}));

function mountGrid() {
  const runtime = hookRuntime();
  const selectionHook = load("usePhotoGridSelection.ts", {
    react: runtime.react,
    "./photoGridSelectionUtils": load("photoGridSelectionUtils.ts", {}),
  });
  let selection;
  const modules = {
    react: runtime.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@tanstack/react-query": { useQueryClient: () => ({}) },
    "../../api/tauri": {},
    "../../api/deletion": {},
    "../../i18n": i18n,
    "../../hooks/useSettings": { useSettings: () => ({ data: {} }) },
    "../../toasts/toast": toastDouble,
    "../../utils/favoriteToasts": favoriteToastsDouble,
    "./photoGridUtils": {
      isVideoAsset: (asset) => asset.type === "VIDEO",
      getAssetAspectRatio: () => 1.5,
    },
    "./usePhotoGridExternalEvents": {
      usePhotoGridExternalEvents: (displayAssets) => ({
        lightboxAssets: displayAssets,
        versionAssetsBySlotId: {},
        layoutRefreshNonce: 0,
      }),
    },
    "./usePhotoGridShortcuts": { usePhotoGridShortcuts() {} },
    "./useSelectionFavorite": { useSelectionFavorite: () => () => {} },
    "./usePhotoGridSelection": {
      usePhotoGridSelection(props) {
        selection = selectionHook.usePhotoGridSelection(props);
        return selection;
      },
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
    "../Media/EditImportPill": { EditImportPill: "EditImportPill" },
    "../FixTime/FixTimeHost": { FixTimeHost: "FixTimeHost" },
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
  const { PhotoGrid } = load("PhotoGrid.tsx", modules);
  const props = { assets, isFetching: false, hasNextPage: false, onLoadMore() {} };
  let tree = runtime.render(PhotoGrid, props);
  const thumbnail = (id) => {
    const result = find(tree, "AssetThumbnail", (props) => props.asset.id === id);
    assert.ok(result, `Missing thumbnail: ${id}`);
    return result;
  };
  return {
    thumbnail,
    selected: () => Array.from(selection.selectedAssetIds).sort(),
    overlay: () => find(tree, "PhotoGridFullscreenOverlay"),
    click(id, modifiers = {}, checkbox = false) {
      let prevented = false;
      let stopped = false;
      thumbnail(id)[checkbox ? "onToggleSelection" : "onOpen"]({
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        ...modifiers,
        preventDefault: () => (prevented = true),
        stopPropagation: () => (stopped = true),
      });
      if (checkbox) {
        assert.ok(prevented && stopped, "checkbox clicks must not bubble to the tile");
      }
      tree = runtime.render(PhotoGrid, props);
    },
  };
}

for (const asset of assets.slice(0, 2)) {
  test(`${asset.type}: a plain click opens fullscreen outside selection mode`, () => {
    const grid = mountGrid();
    assert.equal(grid.thumbnail(asset.id).isSelectionMode, false);
    grid.click(asset.id);
    assert.equal(grid.overlay()?.activeAsset.id, asset.id);
    assert.deepEqual(grid.selected(), []);
  });
}

test("tile clicks select and deselect photos/videos until the last selection is cleared", () => {
  const grid = mountGrid();
  grid.click("asset-0", {}, true);
  assert.deepEqual(grid.selected(), ["asset-0"]);
  assert.equal(grid.overlay(), null);
  for (const asset of assets) assert.equal(grid.thumbnail(asset.id).isSelectionMode, true);

  grid.click("asset-1");
  grid.click("asset-2");
  assert.deepEqual(grid.selected(), ["asset-0", "asset-1", "asset-2"]);
  assert.equal(grid.overlay(), null);

  grid.click("asset-1");
  assert.deepEqual(grid.selected(), ["asset-0", "asset-2"], "video deselection preserves others");
  grid.click("asset-2");
  assert.deepEqual(grid.selected(), ["asset-0"], "photo deselection preserves others");
  grid.click("asset-0");
  assert.deepEqual(grid.selected(), []);
  assert.equal(grid.overlay(), null, "deselecting the final asset must not also open it");
  for (const asset of assets) assert.equal(grid.thumbnail(asset.id).isSelectionMode, false);

  grid.click("asset-1");
  assert.equal(grid.overlay()?.activeAsset.id, "asset-1");
});

for (const modifier of ["metaKey", "ctrlKey"]) {
  test(`${modifier} and Shift selection keep their existing range and toggle behavior`, () => {
    const grid = mountGrid();
    grid.click("asset-0", { [modifier]: true });
    assert.deepEqual(grid.selected(), ["asset-0"]);
    grid.click("asset-2");
    grid.click("asset-3", { shiftKey: true });
    assert.deepEqual(grid.selected(), ["asset-2", "asset-3"], "Shift replaces the selection");
    grid.click("asset-1", { shiftKey: true, [modifier]: true });
    assert.deepEqual(grid.selected(), ["asset-1", "asset-2", "asset-3"]);
    grid.click("asset-2", { [modifier]: true });
    assert.deepEqual(grid.selected(), ["asset-1", "asset-3"]);
    grid.click("asset-1", {}, true);
    assert.deepEqual(grid.selected(), ["asset-3"], "checkboxes still toggle in selection mode");
    assert.equal(grid.overlay(), null);
  });
}

test("thumbnail cursor and accessible action match selection mode for photos and videos", () => {
  for (const asset of assets.slice(0, 2)) {
    for (const suppressFullThumbnail of [false, true]) {
      const runtime = hookRuntime();
      const { AssetThumbnail } = load("AssetThumbnail.tsx", {
        react: { ...runtime.react, useLayoutEffect: (effect) => effect() },
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "lucide-react": {},
        "../../api/tauri": { isThumbnailCached: () => "thumbnail:cached" },
        "../../i18n": i18n,
        "./photoGridUtils": {
          isVideoAsset: (asset) => asset.type === "VIDEO",
          thumbhashToDataUrl: () => null,
          formatVideoDuration: () => "0:10",
        },
      });
      const props = {
        asset,
        isSelected: false,
        isSelectionMode: false,
        onOpen() {},
        onToggleSelection() {},
      };
      runtime.render(AssetThumbnail, props);
      for (const [isSelectionMode, isSelected, action] of [
        [false, false, "openFullscreenAria"],
        [true, false, "selectAssetAria"],
        [true, true, "deselectAssetAria"],
      ]) {
        const button = runtime.render(AssetThumbnail, {
          ...props,
          suppressFullThumbnail,
          isSelectionMode,
          isSelected,
        });
        assert.equal(button.type, "button");
        assert.equal(button.props.onClick, props.onOpen);
        assert.match(button.props.className, isSelectionMode ? /cursor-pointer/ : /cursor-zoom-in/);
        assert.equal(button.props["aria-label"], `photoGrid.${action}:${asset.originalFileName}`);
        assert.equal(button.props["aria-pressed"], isSelectionMode ? isSelected : undefined);
      }
    }
  }
});
