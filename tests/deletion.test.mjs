import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
function load(path, imports) {
  const output = ts.transpileModule(source(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)(
    (name) => {
      assert.ok(name in imports, `Unexpected import ${name}`);
      return imports[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}

test("Delete and restore dispatch the distinct native commands and mutation events", async () => {
  const requests = [];
  const events = [];
  const previous = globalThis.window;
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  try {
    const api = load("../src/api/deletion.ts", {
      "@tauri-apps/api/core": {
        invoke: async (command, payload) => {
          requests.push({ command, payload });
          return { id: payload.assetId };
        },
      },
    });
    await api.deleteAsset("photo");
    await api.restoreDeletedAsset("archive", "archive");
    await api.restoreDeletedAsset("trash", "trash");
    await api.refreshDeletedAssets("trash");
    assert.deepEqual(requests, [
      { command: "delete_asset", payload: { assetId: "photo" } },
      { command: "restore_deleted_asset", payload: { assetId: "archive", mode: "archive" } },
      { command: "restore_deleted_asset", payload: { assetId: "trash", mode: "trash" } },
      { command: "refresh_deleted_assets", payload: { mode: "trash" } },
    ]);
    assert.equal(events.length, 3);
    assert.ok(events.every((event) => event.type === api.ASSET_DELETION_CHANGED_EVENT));
  } finally {
    globalThis.window = previous;
  }
});

test("cached trashed fullscreen controls offer restore without requiring archive visibility", () => {
  const element = (type, props) => ({ type, props });
  const icons = Object.fromEntries(
    ["Archive", "ArchiveRestore", "Heart", "Trash", "Trash2", "Star"].map((name) => [name, name]),
  );
  const { FullscreenMetadataBar } = load("../src/components/PhotoGrid/FullscreenMetadataBar.tsx", {
    "react/jsx-runtime": { jsx: element, jsxs: element },
    react: { useState: (initial) => [initial, () => {}] },
    "lucide-react": icons,
    "../../i18n": { useI18n: () => ({ t: (key) => key }) },
  });
  const asset = {
    id: "cached-trash",
    isArchived: false,
    isTrashed: true,
    visibility: "timeline",
    rating: null,
  };
  const onToggleArchive = () => {};
  function deleteControl(asset) {
    const tree = FullscreenMetadataBar({
      asset,
      onToggleArchive,
      onToggleFavorite() {},
      onSetRating() {},
      isUpdatingFavorite: false,
      isUpdatingArchive: false,
      isUpdatingRating: false,
    });
    const nodes = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node?.props) return;
      nodes.push(node);
      visit(node.props.children);
    }
    visit(tree);
    const button = nodes.find((node) => node.props.onClick === onToggleArchive);
    const tooltip = nodes.find((node) => node.props.children === button);
    return { button, tooltip };
  }
  const trashed = deleteControl(asset);
  assert.equal(trashed.tooltip.props["data-tip"], "settings.restoreDeleted");
  assert.equal(trashed.button.props.children.type, "Trash");
  assert.equal(trashed.button.props.disabled, false);
  const restored = deleteControl({ ...asset, isTrashed: false });
  assert.equal(restored.tooltip.props["data-tip"], "settings.deleteBehaviorTitle");
  assert.equal(restored.button.props.children.type, "Trash2");
});

test("selected Delete preserves action order and completes partial batches before surfacing errors", async () => {
  const order = [];
  const previous = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  try {
    const api = load("../src/api/deletion.ts", {
      "@tauri-apps/api/core": {
        invoke: async (_, { assetId }) => {
          order.push(`start:${assetId}`);
          await Promise.resolve();
          if (assetId === "rejected") throw new Error("server rejected");
          order.push(`end:${assetId}`);
          return { id: assetId };
        },
      },
    });

    await assert.rejects(api.deleteAssets(["a", "rejected", "b"]), /server rejected/);
    assert.deepEqual(order, ["start:a", "end:a", "start:rejected", "start:b", "end:b"]);
  } finally {
    globalThis.window = previous;
  }
});

test("normal Delete of an edited version publishes the protected original fallback", async () => {
  const events = [];
  const previous = globalThis.window;
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  try {
    const api = load("../src/api/deletion.ts", {
      "@tauri-apps/api/core": {
        invoke: async (command) =>
          command === "delete_asset"
            ? { id: "edit", stackOriginalId: "original", isArchived: true }
            : [{ id: "original" }],
      },
    });
    await api.deleteAsset("edit");
    const change = events.find((event) => event.type === "media:versions-changed");
    assert.equal(change.detail.original.id, "original");
    assert.equal(change.detail.deletedAssetId, "edit");
    assert.equal(change.detail.remainingCount, 1);
  } finally {
    globalThis.window = previous;
  }
});

test("opening Deleted refreshes only the selected mode and keeps offline failures observable", async () => {
  for (const [filter, mode] of [
    ["archived", "archive"],
    ["trashed", "trash"],
    ["all", null],
  ]) {
    const effects = [];
    const state = [];
    const calls = [];
    const previous = globalThis.window;
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    try {
      const hooks = load("../src/hooks/useDeletedRefresh.ts", {
        react: {
          useState: (initial) => {
            const index = state.length;
            state.push(initial);
            return [
              initial,
              (next) => {
                state[index] = typeof next === "function" ? next(state[index]) : next;
              },
            ];
          },
          useEffect: (effect, deps) => effects.push({ effect, deps }),
        },
        "../api/deletion": {
          ASSET_DELETION_CHANGED_EVENT: "changed",
          refreshDeletedAssets: async (value) => {
            calls.push(value);
            throw "offline: cached dataset";
          },
        },
      });
      hooks.useDeletedRefresh(filter);
      const cleanups = effects.map(({ effect }) => effect());
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, mode ? [mode] : []);
      assert.equal(state[1], mode ? "offline: cached dataset" : null);
      assert.equal(state[0], mode ? 1 : 0);
      assert.deepEqual(effects[1].deps, [filter]);
      cleanups.forEach((cleanup) => cleanup?.());
    } finally {
      globalThis.window = previous;
    }
  }
});

test("all shared grid Delete paths use the common API and invalidate full layouts", () => {
  for (const page of ["Photos", "Albums", "Calendar", "Folders"]) {
    const text = source(`../src/pages/${page}Page.tsx`);
    assert.match(text, /await deleteAssets\(selectedAssetIds\)/);
    assert.match(text, /finally/);
  }
  const photos = source("../src/pages/PhotosPage.tsx");
  assert.equal(
    (
      photos.match(/\[assetFilter, searchTerm, filterPayload, sortPreference, refreshToken\]/g) ??
      []
    ).length,
    2,
  );
  const grid = source("../src/components/PhotoGrid/PhotoGrid.tsx");
  assert.match(grid, /await restoreDeletedAsset\(activeAsset.id, mode\)/);
  assert.match(grid, /await deleteAsset\(activeAsset.id\)/);
  assert.match(grid, /viewScope\?\.filter === "trashed"/);
  assert.match(grid, /ASSET_DELETION_CHANGED_EVENT/);
  const deleted = source("../src/pages/DeletedPage.tsx");
  assert.match(deleted, /if \(!settings\)/);
  assert.match(deleted, /deleteBehavior === "trash" \? "trashed" : "archived"/);
});

test("Delete preference and mode-specific warnings are localized without altering local cleanup", () => {
  const translations = source("../src/i18n/index.tsx");
  for (const key of [
    "deleteBehaviorTitle",
    "deleteBehaviorArchive",
    "deleteBehaviorTrash",
    "deletedOffline",
    "trashConfirmBody",
  ]) {
    assert.equal((translations.match(new RegExp(`${key}:`, "g")) ?? []).length, 2);
  }
  const api = source("../src/api/deletion.ts");
  assert.doesNotMatch(api, /force:\s*true|empty.trash|delete_local_album|remove_file/);
  const settings = source("../src/pages/SettingsPage.tsx");
  assert.match(settings, /updateSettings\(\{ \.\.\.settings, deleteBehavior \}\)/);
});
