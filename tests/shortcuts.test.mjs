import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const compiled = new Map();
const logs = { debug: [], warn: [], error: [] };
const testConsole = {
  debug: (...args) => logs.debug.push(args),
  info: () => {},
  log: () => {},
  warn: (...args) => logs.warn.push(args),
  error: (...args) => logs.error.push(args),
};

function load(path, modules = {}) {
  if (!compiled.has(path)) {
    compiled.set(
      path,
      ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
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
    console: testConsole,
    require(name) {
      assert.ok(name in modules, `Unexpected import: ${name}`);
      return modules[name];
    },
  });
  return exports;
}

const combo = load("../src/shortcuts/combo.ts");
const catalog = load("../src/shortcuts/catalog.ts", { "./combo": combo });
const { createShortcutRegistry } = load("../src/shortcuts/registry.ts", {
  "./catalog": catalog,
  "./combo": combo,
});

// Values created inside the vm realm must be copied before deep comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));

const event = (init = {}) => ({
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

test("combos are parsed and normalized into one canonical form", () => {
  assert.equal(combo.normalizeCombo("mod+shift+f"), "Mod+Shift+F");
  assert.equal(combo.normalizeCombo("Shift+Mod+F"), "Mod+Shift+F");
  assert.equal(combo.normalizeCombo("Alt+Ctrl+Mod+Shift+x"), "Mod+Ctrl+Alt+Shift+X");
  assert.equal(combo.normalizeCombo("escape"), "Escape");
  assert.equal(combo.normalizeCombo("arrowleft"), "ArrowLeft");
  assert.equal(combo.normalizeCombo("f5"), "F5");
  assert.equal(combo.normalizeCombo("Mod+,"), "Mod+,");

  for (const invalid of [
    "",
    "Mod+",
    "Mod+Mod+F",
    "Cmd+F",
    "Meta+F",
    "Foo",
    "F13",
    "Mod++",
    null,
    5,
  ]) {
    assert.equal(combo.normalizeCombo(invalid), null, `${String(invalid)} should be rejected`);
  }

  assert.deepEqual(plain(combo.normalizeComboList(["f", "F", "bogus", "mod+d", "Mod+D"])), [
    "F",
    "Mod+D",
  ]);
  assert.deepEqual(plain(combo.normalizeComboList("nope")), []);
});

test("key events map to combos on macOS and Windows", () => {
  assert.equal(
    combo.eventToCombo(event({ key: "f", metaKey: true, shiftKey: true }), true),
    "Mod+Shift+F",
  );
  assert.equal(combo.eventToCombo(event({ key: "x", ctrlKey: true }), true), "Ctrl+X");
  assert.equal(combo.eventToCombo(event({ key: "f", ctrlKey: true }), false), "Mod+F");
  assert.equal(combo.eventToCombo(event({ key: "f", metaKey: true }), false), null);
  assert.equal(combo.eventToCombo(event({ key: "Delete" }), true), "Delete");
  assert.equal(combo.eventToCombo(event({ key: " " }), false), "Space");
  assert.equal(combo.eventToCombo(event({ key: "ArrowLeft" }), true), "ArrowLeft");

  // Composed characters fall back to the physical key.
  assert.equal(combo.eventToCombo(event({ key: "ƒ", code: "KeyF", altKey: true }), true), "Alt+F");
  assert.equal(
    combo.eventToCombo(event({ key: "!", code: "Digit1", shiftKey: true }), true),
    "Shift+1",
  );
  assert.equal(
    combo.eventToCombo(event({ key: "Dead", code: "KeyE", altKey: true }), true),
    "Alt+E",
  );
  assert.equal(combo.eventToCombo(event({ key: "5", code: "Numpad5" }), false), "5");

  for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Process", "Unidentified"]) {
    assert.equal(combo.eventToCombo(event({ key }), true), null, `${key} alone is not a combo`);
  }

  const altGr = event({ key: "e", ctrlKey: true, altKey: true });
  altGr.getModifierState = (modifier) => modifier === "AltGraph";
  assert.equal(combo.eventToCombo(altGr, false), null);
});

test("combos are formatted for each platform and converted to native accelerators", () => {
  assert.equal(combo.formatCombo("Mod+Shift+F", true), "⇧⌘F");
  assert.equal(combo.formatCombo("Mod+Ctrl+Alt+Shift+F", true), "⌃⌥⇧⌘F");
  assert.equal(combo.formatCombo("Mod+Shift+F", false), "Ctrl+Shift+F");
  assert.equal(combo.formatCombo("Delete", true), "⌦");
  assert.equal(combo.formatCombo("Delete", false), "Del");
  assert.equal(combo.formatCombo("ArrowLeft", false), "←");

  assert.equal(combo.comboToAccelerator("Mod+Shift+F"), "CmdOrCtrl+Shift+F");
  assert.equal(combo.comboToAccelerator("Mod+,"), "CmdOrCtrl+,");
  assert.equal(combo.comboToAccelerator("Ctrl+Alt+Delete"), "Ctrl+Alt+Delete");
  assert.equal(combo.comboToAccelerator("nope"), null);

  // Bare-key and Shift-only bindings never become native accelerators.
  assert.equal(
    combo.getNativeAccelerator(["Delete", "Backspace", "Mod+Backspace"]),
    "CmdOrCtrl+Backspace",
  );
  assert.equal(combo.getNativeAccelerator(["F", "Mod+D"]), "CmdOrCtrl+D");
  assert.equal(combo.getNativeAccelerator(["F"]), null);
  assert.equal(combo.getNativeAccelerator(["Shift+F"]), null);
  assert.equal(combo.getNativeAccelerator(["Mod+C"]), null);
  assert.equal(combo.getNativeAccelerator([]), null);
});

test("reserved and text-editing combos are recognized", () => {
  for (const reserved of [
    "Mod+C",
    "Mod+V",
    "Mod+X",
    "Mod+Z",
    "Mod+Shift+Z",
    "Mod+Q",
    "Alt+F4",
    "Tab",
    "Enter",
    "Space",
    "bogus",
  ]) {
    assert.equal(combo.isReservedCombo(reserved), true, `${reserved} is reserved`);
  }
  for (const free of ["Mod+Shift+F", "F", "Delete", "Mod+D", "Escape"]) {
    assert.equal(combo.isReservedCombo(free), false, `${free} is assignable`);
  }

  for (const editing of ["Mod+A", "Mod+Backspace", "Mod+Delete", "Mod+ArrowLeft", "Mod+Home"]) {
    assert.equal(combo.isTextEditingCombo(editing), true, `${editing} edits text`);
  }
  for (const other of ["Mod+F", "Mod+1", "A", "Backspace", "Mod+Shift+A"]) {
    assert.equal(combo.isTextEditingCombo(other), false, `${other} does not edit text`);
  }
});

test("the catalog covers the requested actions with valid, conflict-free defaults", () => {
  const ids = new Set();
  for (const action of catalog.SHORTCUT_ACTIONS) {
    assert.ok(!ids.has(action.id), `${action.id} is declared once`);
    ids.add(action.id);
    assert.ok(
      catalog.SHORTCUT_GROUP_ORDER.includes(action.group),
      `${action.id} has a known group`,
    );
    assert.ok(action.contexts.length > 0, `${action.id} declares contexts`);
    assert.ok(action.defaults.length > 0, `${action.id} has a default binding`);
    for (const defaultCombo of action.defaults) {
      assert.equal(
        combo.normalizeCombo(defaultCombo),
        defaultCombo,
        `${action.id}: ${defaultCombo} is canonical`,
      );
      assert.equal(
        combo.isReservedCombo(defaultCombo),
        false,
        `${action.id}: ${defaultCombo} is not reserved`,
      );
      assert.equal(
        catalog.getComboRejection(action.id, defaultCombo),
        null,
        `${action.id}: ${defaultCombo} is valid`,
      );
      assert.deepEqual(
        plain(catalog.findConflicts(catalog.DEFAULT_BINDINGS, action.id, defaultCombo)),
        [],
        `${action.id}: ${defaultCombo} does not conflict`,
      );
    }
  }

  for (const required of [
    "photo.addToAlbum",
    "photo.delete",
    "photo.share",
    "photo.edit",
    "photo.toggleInfo",
    "photo.favorite",
    "photo.rate0",
    "photo.rate1",
    "photo.rate2",
    "photo.rate3",
    "photo.rate4",
    "photo.rate5",
    "view.toggleFilter",
    "view.sortField",
    "view.sortDirection",
    "album.create",
    "nav.albums",
  ]) {
    assert.ok(ids.has(required), `${required} exists`);
  }
  assert.equal(catalog.isShortcutActionId("photo.delete"), true);
  assert.equal(catalog.isShortcutActionId("photo.nothing"), false);
});

test("overrides are merged over defaults and only differences are persisted", () => {
  assert.deepEqual(plain(catalog.resolveBindings(null)), plain(catalog.DEFAULT_BINDINGS));
  assert.deepEqual(plain(catalog.diffOverrides(catalog.resolveBindings({}))), {});

  const bindings = catalog.resolveBindings({
    "photo.favorite": ["x"],
    "photo.delete": [],
    "photo.share": "invalid",
    "photo.edit": ["Mod+C", "z", "Z", "bogus"],
    "unknown.action": ["Q"],
  });
  assert.deepEqual(plain(bindings["photo.favorite"]), ["X"]);
  assert.deepEqual(plain(bindings["photo.delete"]), []);
  assert.deepEqual(plain(bindings["photo.share"]), plain(catalog.DEFAULT_BINDINGS["photo.share"]));
  assert.deepEqual(plain(bindings["photo.edit"]), ["Z"]);
  assert.equal("unknown.action" in bindings, false);

  assert.deepEqual(plain(catalog.diffOverrides(bindings)), {
    "photo.favorite": ["X"],
    "photo.delete": [],
    "photo.edit": ["Z"],
  });
  assert.equal(catalog.isDefaultBinding(bindings, "photo.share"), true);
  assert.equal(catalog.isDefaultBinding(bindings, "photo.favorite"), false);
});

test("conflicts only count when actions can fire in the same context", () => {
  const bindings = catalog.DEFAULT_BINDINGS;

  // Escape is shared by the viewer and the grid, which never fire together.
  assert.deepEqual(plain(catalog.findConflicts(bindings, "view.close", "Escape")), []);
  assert.deepEqual(plain(catalog.findConflicts(bindings, "photo.edit", "F")), ["photo.favorite"]);
  assert.deepEqual(plain(catalog.findConflicts(bindings, "view.toggleFilter", "F")), [
    "photo.favorite",
  ]);
  assert.deepEqual(plain(catalog.findConflicts(bindings, "photo.rate1", "I")), [
    "photo.toggleInfo",
  ]);
  assert.deepEqual(plain(catalog.findConflicts(bindings, "view.focusSearch", "Mod+1")), [
    "nav.photos",
  ]);
  assert.deepEqual(plain(catalog.findConflicts(bindings, "photo.favorite", "F")), []);
  assert.deepEqual(plain(catalog.findConflicts(bindings, "photo.favorite", "nonsense")), []);
});

test("combo rejection explains why a combo cannot be assigned", () => {
  assert.equal(catalog.getComboRejection("photo.favorite", "Mod+C"), "reserved");
  assert.equal(catalog.getComboRejection("photo.favorite", "bogus"), "invalid");
  assert.equal(catalog.getComboRejection("nav.photos", "Mod+Backspace"), "textEditing");
  assert.equal(catalog.getComboRejection("photo.delete", "Mod+Backspace"), null);
});

test("binding helpers add, remove, steal, and reset combos without mutating", () => {
  const base = catalog.DEFAULT_BINDINGS;

  const added = catalog.withBinding(base, "photo.edit", "mod+k");
  assert.deepEqual(plain(added["photo.edit"]), ["E", "Mod+K"]);
  assert.deepEqual(plain(base["photo.edit"]), ["E"]);
  assert.equal(catalog.withBinding(added, "photo.edit", "Mod+K"), added);

  const removed = catalog.withoutBinding(added, "photo.edit", "E");
  assert.deepEqual(plain(removed["photo.edit"]), ["Mod+K"]);

  const stolen = catalog.withoutConflicts(base, "photo.edit", "F");
  assert.deepEqual(plain(stolen["photo.favorite"]), ["Mod+D"]);

  const taken = catalog.withBinding(stolen, "photo.edit", "F");
  const restored = catalog.resetBinding(taken, "photo.favorite");
  assert.deepEqual(plain(restored["photo.favorite"]), ["F", "Mod+D"]);
  assert.deepEqual(plain(restored["photo.edit"]), ["E"]);
});

function createFixture({ isMac = true } = {}) {
  const state = { context: "browse", modal: false, time: 1000 };
  const registry = createShortcutRegistry({
    isMac,
    getContext: () => state.context,
    isModalOpen: () => state.modal,
    isEditableTarget: (target) => !!target && target.editable === true,
    blurEditable: (target) => {
      target.blurred = true;
    },
    now: () => state.time,
  });
  const bindings = catalog.resolveBindings(null);
  const press = (init) => {
    const keyEvent = {
      ...event(),
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null,
      prevented: 0,
      ...init,
    };
    keyEvent.preventDefault = () => {
      keyEvent.prevented += 1;
      keyEvent.defaultPrevented = true;
    };
    keyEvent.handled = registry.handleKeyDown(keyEvent, bindings);
    return keyEvent;
  };
  return { registry, state, bindings, press };
}

test("registered handlers run for their binding and prevent the default action", () => {
  const { registry, press } = createFixture();
  let calls = 0;
  registry.register("photo.favorite", () => {
    calls += 1;
  });

  const handled = press({ key: "f" });
  assert.equal(handled.handled, true);
  assert.equal(handled.prevented, 1);
  assert.equal(calls, 1);

  const unbound = press({ key: "q" });
  assert.equal(unbound.handled, false);
  assert.equal(unbound.prevented, 0);

  const viaModifier = press({ key: "d", metaKey: true });
  assert.equal(viaModifier.handled, true);
  assert.equal(calls, 2);

  assert.equal(press({ key: "f", defaultPrevented: true }).handled, false);
  assert.equal(press({ key: "f", isComposing: true }).handled, false);
  assert.equal(calls, 2);
});

test("keys map to Mod on both platforms and Meta is ignored on Windows", () => {
  const mac = createFixture({ isMac: true });
  let macCalls = 0;
  mac.registry.register("view.focusSearch", () => {
    macCalls += 1;
  });
  assert.equal(mac.press({ key: "f", metaKey: true }).handled, true);
  assert.equal(mac.press({ key: "f", ctrlKey: true }).handled, false);
  assert.equal(macCalls, 1);

  const windows = createFixture({ isMac: false });
  let windowsCalls = 0;
  windows.registry.register("view.focusSearch", () => {
    windowsCalls += 1;
  });
  assert.equal(windows.press({ key: "f", ctrlKey: true }).handled, true);
  assert.equal(windows.press({ key: "f", metaKey: true }).handled, false);
  assert.equal(windowsCalls, 1);
});

test("handlers only run in the context they were registered for", () => {
  const { registry, state, press } = createFixture();
  const calls = [];
  registry.register("view.close", () => calls.push("close"), "viewer");
  registry.register("selection.clear", () => calls.push("clear"), "browse");

  press({ key: "Escape" });
  state.context = "viewer";
  press({ key: "Escape" });
  state.context = "browse";
  press({ key: "Escape" });

  assert.deepEqual(calls, ["clear", "close", "clear"]);
});

test("global handlers are a fallback behind context handlers and newer registrations win", () => {
  const { registry, state, press } = createFixture();
  const calls = [];
  registry.register("album.create", () => calls.push("global"), "global");
  registry.register("album.create", () => calls.push("viewer"), "viewer");

  press({ key: "n", metaKey: true });
  state.context = "viewer";
  press({ key: "n", metaKey: true });

  registry.register("album.create", () => calls.push("newer-global"), "global");
  press({ key: "n", metaKey: true });
  state.context = "browse";
  press({ key: "n", metaKey: true });

  assert.deepEqual(calls, ["global", "viewer", "viewer", "newer-global"]);
});

test("a handler returning false lets older handlers and the browser take over", () => {
  const { registry, press } = createFixture();
  const calls = [];
  registry.register("photo.favorite", () => calls.push("older"));
  const unregisterNewer = registry.register("photo.favorite", () => {
    calls.push("newer");
    return false;
  });

  const handled = press({ key: "f" });
  assert.deepEqual(calls, ["newer", "older"]);
  assert.equal(handled.handled, true);

  const declined = createFixture();
  declined.registry.register("photo.favorite", () => false);
  const result = declined.press({ key: "f" });
  assert.equal(result.handled, false);
  assert.equal(result.prevented, 0);

  unregisterNewer();
  calls.length = 0;
  press({ key: "f" });
  assert.deepEqual(calls, ["older"]);
});

test("handler errors are logged and swallowed, and async rejections are logged", async () => {
  logs.error.length = 0;
  const { registry, press } = createFixture();
  registry.register("photo.favorite", () => {
    throw new Error("boom");
  });
  const thrown = press({ key: "f" });
  assert.equal(thrown.handled, true);
  assert.equal(thrown.prevented, 1);
  assert.equal(logs.error.length, 1);
  assert.match(String(logs.error[0][0]), /\[shortcuts\] photo\.favorite handler failed/);

  const asyncFixture = createFixture();
  asyncFixture.registry.register("photo.favorite", () => Promise.reject(new Error("later")));
  assert.equal(asyncFixture.press({ key: "f" }).handled, true);
  await tick();
  assert.equal(logs.error.length, 2);
  assert.match(String(logs.error[1][0]), /\[shortcuts\] photo\.favorite handler rejected/);
});

test("typing in a text field only allows Mod shortcuts that opt in", () => {
  const { registry, press } = createFixture();
  const calls = [];
  registry.register("photo.favorite", () => calls.push("favorite"));
  registry.register("selection.selectAll", () => calls.push("selectAll"));
  registry.register("view.focusSearch", () => calls.push("search"));
  registry.register("nav.photos", () => calls.push("photos"), "global");
  const target = { editable: true };

  assert.equal(press({ key: "f", target }).handled, false);
  assert.equal(press({ key: "a", metaKey: true, target }).handled, false);
  assert.equal(press({ key: "/", target }).handled, false);
  assert.equal(press({ key: "f", metaKey: true, target }).handled, true);
  assert.equal(press({ key: "1", metaKey: true, target }).handled, true);
  assert.deepEqual(calls, ["search", "photos"]);

  assert.equal(press({ key: "/" }).handled, true);
  assert.equal(press({ key: "a", metaKey: true }).handled, true);
  assert.deepEqual(calls, ["search", "photos", "search", "selectAll"]);
});

test("Escape inside a text field only leaves the field", () => {
  const { registry, press } = createFixture();
  let cleared = 0;
  registry.register("selection.clear", () => {
    cleared += 1;
  });
  const target = { editable: true, blurred: false };

  const first = press({ key: "Escape", target });
  assert.equal(first.handled, true);
  assert.equal(first.prevented, 1);
  assert.equal(target.blurred, true);
  assert.equal(cleared, 0);

  assert.equal(press({ key: "Escape" }).handled, true);
  assert.equal(cleared, 1);

  const untouched = { editable: true, blurred: false };
  const { press: pressWithoutHandler } = createFixture();
  assert.equal(pressWithoutHandler({ key: "Escape", target: untouched }).handled, false);
  assert.equal(untouched.blurred, false);
});

test("key repeat is swallowed unless the action is repeatable", () => {
  const { registry, state, press } = createFixture();
  let deletes = 0;
  let nexts = 0;
  registry.register("photo.delete", () => {
    deletes += 1;
  });
  registry.register(
    "view.next",
    () => {
      nexts += 1;
    },
    "viewer",
  );

  press({ key: "Delete" });
  const repeated = press({ key: "Delete", repeat: true });
  assert.equal(repeated.handled, true);
  assert.equal(repeated.prevented, 1);
  assert.equal(deletes, 1);

  state.context = "viewer";
  press({ key: "ArrowRight" });
  press({ key: "ArrowRight", repeat: true });
  press({ key: "ArrowRight", repeat: true });
  assert.equal(nexts, 3);

  // Repeats of keys nobody handles are left alone.
  assert.equal(press({ key: "q", repeat: true }).handled, false);
});

test("a menu click and a key press for the same action only run once", () => {
  const { registry, state, press } = createFixture();
  let calls = 0;
  registry.register("photo.favorite", () => {
    calls += 1;
  });

  assert.equal(registry.dispatch("photo.favorite", "menu"), true);
  const duplicate = press({ key: "d", metaKey: true });
  assert.equal(duplicate.handled, true);
  assert.equal(duplicate.prevented, 1);
  assert.equal(calls, 1);

  state.time += 500;
  press({ key: "d", metaKey: true });
  assert.equal(calls, 2);

  state.time += 10;
  assert.equal(registry.dispatch("photo.favorite", "menu"), true);
  assert.equal(calls, 2);

  state.time += 500;
  press({ key: "f" });
  press({ key: "f" });
  assert.equal(calls, 4);
});

test("dialogs and the settings recorder suspend shortcuts", () => {
  const { registry, state, press } = createFixture();
  let calls = 0;
  registry.register("photo.favorite", () => {
    calls += 1;
  });

  state.modal = true;
  assert.equal(press({ key: "f" }).handled, false);
  assert.equal(registry.dispatch("photo.favorite", "menu"), false);
  state.modal = false;

  let captureNotifications = 0;
  const unsubscribe = registry.subscribeCapture(() => {
    captureNotifications += 1;
  });
  const endCapture = registry.beginCapture();
  assert.equal(registry.isCaptureActive(), true);
  assert.equal(press({ key: "f" }).handled, false);
  endCapture();
  endCapture();
  assert.equal(registry.isCaptureActive(), false);
  assert.equal(captureNotifications, 2);
  unsubscribe();

  assert.equal(press({ key: "f" }).handled, true);
  assert.equal(calls, 1);
});

test("menu dispatch needs an eligible handler and honors fallthrough", () => {
  const { registry, state } = createFixture();
  const calls = [];
  assert.equal(registry.dispatch("photo.share", "menu"), false);

  registry.register("photo.share", () => calls.push("viewer"), "viewer");
  assert.equal(registry.dispatch("photo.share", "menu"), false);
  state.context = "viewer";
  assert.equal(registry.dispatch("photo.share", "menu"), true);

  registry.register("photo.share", () => false, "viewer");
  state.time += 500;
  assert.equal(registry.dispatch("photo.share", "menu"), true);
  assert.deepEqual(calls, ["viewer", "viewer"]);
});

test("availability reflects the current context and notifies subscribers", async () => {
  const { registry, state } = createFixture();
  let notifications = 0;
  const unsubscribe = registry.subscribeAvailability(() => {
    notifications += 1;
  });

  const unregisterBrowse = registry.register("photo.favorite", () => {}, "browse");
  registry.register("photo.edit", () => {}, "viewer");
  registry.register("nav.photos", () => {}, "global");
  await tick();
  assert.equal(notifications, 1);
  assert.deepEqual([...registry.getAvailableActionIds()].sort(), ["nav.photos", "photo.favorite"]);

  state.context = "viewer";
  assert.deepEqual([...registry.getAvailableActionIds()].sort(), ["nav.photos", "photo.edit"]);

  unregisterBrowse();
  unregisterBrowse();
  await tick();
  assert.equal(notifications, 2);

  unsubscribe();
  registry.register("photo.rate1", () => {}, "viewer");
  await tick();
  assert.equal(notifications, 2);
});
