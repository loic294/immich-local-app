import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const compiled = new Map();

function load(path, modules = {}) {
  if (!compiled.has(path)) {
    compiled.set(
      path,
      ts.transpileModule(read(path), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    );
  }
  const exports = {};
  runInNewContext(compiled.get(path), {
    exports,
    console,
    require(name) {
      assert.ok(name in modules, `Unexpected import: ${name}`);
      return modules[name];
    },
  });
  return exports;
}

const combo = load("../src/shortcuts/combo.ts");
const catalog = load("../src/shortcuts/catalog.ts", { "./combo": combo });
const menu = load("../src/shortcuts/appMenu.ts", { "./combo": combo });

// Values created inside the vm realm must be copied before deep comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));

const submenuIds = plain(menu.MENU_SUBMENU_IDS);
const systemIds = plain(menu.MENU_SYSTEM_IDS);
const actionIds = plain(menu.MENU_ACTION_IDS);

const labels = {
  submenus: Object.fromEntries(submenuIds.map((id) => [id, `submenu ${id}`])),
  items: Object.fromEntries(actionIds.map((id) => [id, `item ${id}`])),
  system: Object.fromEntries(systemIds.map((id) => [id, `system ${id}`])),
};

const menuState = (overrides = {}) => ({
  labels,
  bindings: catalog.resolveBindings(),
  availableActionIds: new Set(actionIds),
  acceleratorsSuspended: false,
  ...overrides,
});

const entriesFor = (overrides) => plain(menu.buildAppMenuEntries(menuState(overrides)));
const actionEntries = (entries) => entries.filter((entry) => actionIds.includes(entry.id));

test("the menu has one entry per submenu, system item and action, in structure order", () => {
  const entries = entriesFor();
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [...submenuIds, ...systemIds, ...actionIds],
  );
  for (const entry of entries) {
    const group = actionIds.includes(entry.id)
      ? labels.items
      : systemIds.includes(entry.id)
        ? labels.system
        : labels.submenus;
    assert.equal(entry.label, group[entry.id], `${entry.id} uses the supplied label`);
  }
});

test("only action entries carry an accelerator and an enabled state", () => {
  for (const entry of entriesFor()) {
    const isAction = actionIds.includes(entry.id);
    assert.equal("accelerator" in entry, isAction, `${entry.id} accelerator`);
    assert.equal("enabled" in entry, isAction, `${entry.id} enabled`);
  }
});

test("default bindings become the native accelerators shown in the menu", () => {
  const accelerators = Object.fromEntries(
    actionEntries(entriesFor()).map((entry) => [entry.id, entry.accelerator]),
  );
  assert.deepEqual(accelerators, {
    "photo.favorite": "CmdOrCtrl+D",
    "photo.delete": "CmdOrCtrl+Backspace",
    "photo.addToAlbum": "CmdOrCtrl+Shift+A",
    "album.create": "CmdOrCtrl+N",
    "nav.albums": "CmdOrCtrl+2",
    "photo.share": "CmdOrCtrl+Shift+S",
    "photo.copyToClipboard": "CmdOrCtrl+Shift+C",
    "photo.showInFolder": "CmdOrCtrl+Shift+E",
    "photo.copyToFolder": "CmdOrCtrl+Shift+U",
    "nav.settings": "CmdOrCtrl+,",
  });
});

test("customized bindings are reflected, and unusable ones leave the item without one", () => {
  const bindings = {
    ...catalog.resolveBindings(),
    "photo.favorite": ["Mod+K"],
    "photo.delete": ["Delete"],
    "photo.share": [],
    "album.create": ["Mod+Q"],
    "photo.addToAlbum": ["A", "Mod+Q", "Mod+Alt+Shift+Y"],
  };
  const byId = Object.fromEntries(
    actionEntries(entriesFor({ bindings })).map((entry) => [entry.id, entry.accelerator]),
  );
  assert.equal(byId["photo.favorite"], "CmdOrCtrl+K");
  assert.equal(byId["photo.delete"], null, "a bare key stays JavaScript-only");
  assert.equal(byId["photo.share"], null, "an unbound action has no accelerator");
  assert.equal(byId["album.create"], null, "a reserved combo is never a native accelerator");
  assert.equal(
    byId["photo.addToAlbum"],
    "CmdOrCtrl+Alt+Shift+Y",
    "unusable bindings are skipped for the first usable one",
  );
});

test("items are enabled only for the actions that can run in the current view", () => {
  const entries = actionEntries(
    entriesFor({ availableActionIds: new Set(["photo.favorite", "nav.albums"]) }),
  );
  assert.deepEqual(
    entries.filter((entry) => entry.enabled).map((entry) => entry.id),
    ["photo.favorite", "nav.albums"],
  );
  assert.ok(entries.every((entry) => typeof entry.enabled === "boolean"));
});

test("native accelerators are withheld while typing or recording a shortcut", () => {
  const entries = actionEntries(entriesFor({ acceleratorsSuspended: true }));
  assert.equal(entries.length, actionIds.length);
  assert.ok(entries.every((entry) => entry.accelerator === null));
  assert.ok(
    entries.every((entry) => entry.enabled),
    "suspending accelerators does not disable the items",
  );
});

test("entry lists are compared by every field that changes the native menu", () => {
  const entries = () => menu.buildAppMenuEntries(menuState());
  assert.equal(menu.appMenuEntriesEqual(entries(), entries()), true);

  const change = (id, patch) =>
    entries().map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  assert.equal(menu.appMenuEntriesEqual(entries(), change("photo.delete", { label: "x" })), false);
  assert.equal(
    menu.appMenuEntriesEqual(entries(), change("photo.delete", { accelerator: null })),
    false,
  );
  assert.equal(
    menu.appMenuEntriesEqual(entries(), change("photo.delete", { enabled: false })),
    false,
  );
  assert.equal(menu.appMenuEntriesEqual(entries(), entries().slice(1)), false);
});

const rust = read("../src-tauri/src/app_menu.rs");

function rustIds(name) {
  const match = rust.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\];`));
  assert.ok(match, `${name} is missing from app_menu.rs`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((id) => id[1]);
}

test("the native menu in Rust implements exactly the ids the frontend contract lists", () => {
  for (const [name, frontendIds] of [
    ["ACTION_IDS", actionIds],
    ["SUBMENU_IDS", submenuIds],
    ["SYSTEM_IDS", systemIds],
  ]) {
    assert.equal(new Set(frontendIds).size, frontendIds.length, `${name} has duplicates in TS`);
    assert.deepEqual(rustIds(name).sort(), [...frontendIds].sort(), `${name} drifted`);
  }
});

test("the menu event and command names agree across Rust, the bridge, and the command list", () => {
  const bridge = read("../src/api/appMenu.ts");
  const rustEvent = rust.match(/const MENU_ACTION_EVENT: &str = "([^"]+)";/)?.[1];
  const tsEvent = bridge.match(/APP_MENU_ACTION_EVENT = "([^"]+)";/)?.[1];
  assert.ok(rustEvent, "MENU_ACTION_EVENT is missing from app_menu.rs");
  assert.equal(tsEvent, rustEvent);

  assert.match(rust, /pub fn update_app_menu\(/);
  assert.match(bridge, /invoke<void>\("update_app_menu"/);

  const main = read("../src-tauri/src/main.rs");
  assert.match(main, /app_menu::update_app_menu/, "command is not registered");
  assert.match(main, /app_menu::install\(tauri::Builder::default\(\)\)/, "menu is not installed");
});
