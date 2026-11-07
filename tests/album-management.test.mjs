import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";

// The dialogs portal into document.body; these tests only inspect the element tree.
globalThis.document ??= { body: {} };

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

function findAll(node, matches, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, matches, found);
  } else if (node && typeof node === "object" && "props" in node) {
    if (matches(node)) found.push(node);
    findAll(node.props.children, matches, found);
  }
  return found;
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

// Minimal hook host: state persists across calls, effects never run.
function createHookHost() {
  const slots = [];
  let cursor = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      const set = (next) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      };
      return [slots[index], set];
    },
    useCallback: (callback) => callback,
    useRef: (current) => ({ current }),
    useEffect: () => {},
    useId: () => "id",
  };
  return {
    hooks,
    run(render) {
      cursor = 0;
      return render();
    },
  };
}

const labels = {
  actionsAria: "Album actions",
  offlineHint: "OFFLINE HINT",
  rename: "Rename album",
  renameTitle: "RENAME TITLE",
  renameField: "Album name",
  renameEmpty: "EMPTY NAME",
  renameSave: "Save",
  renaming: "Saving",
  renameFailed: "RENAME FAILED",
  delete: "Delete album",
  deleteTitle: "DELETE TITLE",
  deleteConfirm: "DELETE CONFIRM",
  deleteSharedWarning: "SHARED WARNING",
  deleting: "Deleting",
  deleteFailed: "DELETE FAILED",
  offline: "OFFLINE NOTICE",
};
const labelsDouble = { useAlbumManagementLabels: () => labels };
const album = { id: "album-1", albumName: "Holiday", shared: false };

test("rename and delete invoke their native commands and announce the change", async () => {
  const requests = [];
  const events = [];
  const previous = globalThis.window;
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  try {
    const api = load("src/api/albumManagement.ts", {
      "@tauri-apps/api/core": {
        invoke: async (command, payload) => {
          requests.push({ command, payload });
          return command === "rename_album" ? "Saved name" : undefined;
        },
      },
    });
    assert.equal(await api.renameAlbum("album-1", "New name"), "Saved name");
    await api.deleteAlbum("album-1");
    assert.deepEqual(requests, [
      { command: "rename_album", payload: { albumId: "album-1", albumName: "New name" } },
      { command: "delete_album", payload: { albumId: "album-1" } },
    ]);
    assert.deepEqual(
      events.map((event) => event.type),
      ["recent-albums-changed", "recent-albums-changed"],
    );
  } finally {
    globalThis.window = previous;
  }
});

test("a rejected rename or delete does not announce a change", async () => {
  const events = [];
  const previous = globalThis.window;
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  try {
    const api = load("src/api/albumManagement.ts", {
      "@tauri-apps/api/core": {
        invoke: async () => {
          throw new Error("offline: no server");
        },
      },
    });
    await assert.rejects(api.renameAlbum("album-1", "New name"), /offline:/);
    await assert.rejects(api.deleteAlbum("album-1"), /offline:/);
    assert.equal(events.length, 0);
  } finally {
    globalThis.window = previous;
  }
});

test("album management labels exist for every locale with identical keys", () => {
  const labelsFor = (locale) =>
    load("src/i18n/albumManagement.ts", {
      "./index": { useI18n: () => ({ locale }) },
    }).useAlbumManagementLabels();
  const english = labelsFor("en-CA");
  const french = labelsFor("fr-CA");
  assert.deepEqual(Object.keys(french).sort(), Object.keys(english).sort());
  for (const [key, value] of [...Object.entries(english), ...Object.entries(french)]) {
    assert.ok(value.trim().length > 0, `${key} has text`);
  }
});

function mountHook({ isOnline = true, rename, remove } = {}) {
  const host = createHookHost();
  const apiCalls = [];
  const cacheWrites = [];
  const removedQueries = [];
  const deleted = [];
  const { useAlbumManagement } = load("src/hooks/useAlbumManagement.ts", {
    react: host.hooks,
    "@tanstack/react-query": {
      useQueryClient: () => ({
        setQueryData: (queryKey, updater) => cacheWrites.push({ queryKey, updater }),
        removeQueries: ({ queryKey }) => removedQueries.push(queryKey),
      }),
    },
    "../api/albumManagement": {
      renameAlbum: async (albumId, albumName) => {
        apiCalls.push({ command: "rename", albumId, albumName });
        return rename ? rename(albumName) : albumName;
      },
      deleteAlbum: async (albumId) => {
        apiCalls.push({ command: "delete", albumId });
        if (remove) await remove();
      },
    },
    "../i18n/albumManagement": labelsDouble,
    "./connectionContext": { useConnectionContext: () => ({ isOnline }) },
  });
  return {
    apiCalls,
    cacheWrites,
    removedQueries,
    deleted,
    state: () => host.run(() => useAlbumManagement(album, (albumId) => deleted.push(albumId))),
  };
}

test("opening the delete dialog only asks for confirmation", () => {
  const hook = mountHook();
  hook.state().openDialog("delete");
  assert.equal(hook.state().dialog, "delete");
  hook.state().closeDialog();
  assert.equal(hook.state().dialog, null);
  assert.deepEqual(hook.apiCalls, [], "neither opening nor cancelling deletes anything");
  assert.deepEqual(hook.deleted, []);
});

test("a confirmed delete drops the album from every cache and closes the dialog", async (t) => {
  t.mock.method(console, "info", () => {});
  const hook = mountHook();
  hook.state().openDialog("delete");
  await hook.state().remove();

  assert.deepEqual(hook.apiCalls, [{ command: "delete", albumId: "album-1" }]);
  assert.deepEqual(hook.deleted, ["album-1"]);
  const [write] = hook.cacheWrites;
  assert.deepEqual(write.queryKey, ["albums"]);
  assert.deepEqual(write.updater([{ id: "album-1" }, { id: "album-2" }]), [{ id: "album-2" }]);
  assert.equal(write.updater(undefined), undefined);
  assert.deepEqual(hook.removedQueries, [
    ["album-assets-paged", "album-1"],
    ["album-local-status", "album-1"],
  ]);
  const state = hook.state();
  assert.deepEqual([state.dialog, state.busy, state.error], [null, false, null]);
});

test("a failed delete keeps the dialog open and leaves every cache alone", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const failures = [
    ["offline: Connect to the album's server to delete it.", labels.offline],
    [new Error("HTTP 400"), labels.deleteFailed],
  ];
  for (const [failure, message] of failures) {
    const hook = mountHook({
      remove: async () => {
        throw failure;
      },
    });
    hook.state().openDialog("delete");
    await hook.state().remove();

    const state = hook.state();
    assert.deepEqual([state.dialog, state.busy, state.error], ["delete", false, message]);
    assert.deepEqual(hook.deleted, []);
    assert.deepEqual(hook.cacheWrites, []);
    assert.deepEqual(hook.removedQueries, []);
  }
});

test("a rename caches the server-confirmed name on that album only", async (t) => {
  t.mock.method(console, "info", () => {});
  const hook = mountHook({ rename: async () => "Holiday 2024" });
  hook.state().openDialog("rename");
  await hook.state().rename("holiday 2024");

  assert.deepEqual(hook.apiCalls, [
    { command: "rename", albumId: "album-1", albumName: "holiday 2024" },
  ]);
  const [write] = hook.cacheWrites;
  assert.deepEqual(write.queryKey, ["albums"]);
  assert.deepEqual(
    write.updater([
      { id: "album-1", albumName: "Holiday" },
      { id: "album-2", albumName: "Other" },
    ]),
    [
      { id: "album-1", albumName: "Holiday 2024" },
      { id: "album-2", albumName: "Other" },
    ],
  );
  assert.equal(hook.state().dialog, null);
});

test("a failed rename keeps the modal open with a localized error", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  // Tauri rejects with plain strings, so both shapes must map to the same messages.
  const failures = [
    ["offline: Connect to the album's server to rename it.", labels.offline],
    ["Album not found", labels.renameFailed],
  ];
  for (const [failure, message] of failures) {
    const hook = mountHook({
      rename: async () => {
        throw failure;
      },
    });
    hook.state().openDialog("rename");
    await hook.state().rename("Summer");

    const state = hook.state();
    assert.deepEqual([state.dialog, state.busy, state.error], ["rename", false, message]);
    assert.deepEqual(hook.cacheWrites, []);
  }
});

test("album management is only available once the server connection is confirmed", () => {
  for (const [isOnline, expected] of [
    [true, true],
    [false, false],
    [null, false],
  ]) {
    assert.equal(mountHook({ isOnline }).state().online, expected);
  }
});

function mountMenu(props = {}) {
  const calls = [];
  const { AlbumActionsMenu } = load("src/components/Albums/AlbumActionsMenu.tsx", {
    react: { ...React, useRef: (current) => ({ current }), useEffect: () => {} },
    "lucide-react": { MoreHorizontal: () => null, Pencil: () => null, Trash2: () => null },
    "../../i18n/albumManagement": labelsDouble,
  });
  const tree = AlbumActionsMenu({
    online: true,
    onRename: () => calls.push("rename"),
    onDelete: () => calls.push("delete"),
    ...props,
  });
  return {
    calls,
    text: textOf(tree),
    summary: findAll(tree, (node) => node.type === "summary")[0],
    buttons: findAll(tree, (node) => node.type === "button"),
  };
}

test("the three-dot menu offers Rename and Delete album", () => {
  const menu = mountMenu();
  assert.equal(menu.summary.props["aria-label"], "Album actions");
  assert.deepEqual(
    menu.buttons.map((button) => textOf(button)),
    ["Rename album", "Delete album"],
  );
  assert.ok(menu.buttons.every((button) => button.props.disabled === false));
  assert.doesNotMatch(menu.text, /OFFLINE HINT/);
  menu.buttons[0].props.onClick();
  menu.buttons[1].props.onClick();
  assert.deepEqual(menu.calls, ["rename", "delete"]);
});

test("the three-dot menu disables both actions and explains why while offline", () => {
  const menu = mountMenu({ online: false });
  assert.ok(menu.buttons.every((button) => button.props.disabled === true));
  assert.match(menu.text, /OFFLINE HINT/);
});

function mountActions(management) {
  const Menu = () => null;
  const RenameModal = () => null;
  const DeleteDialog = () => null;
  const { AlbumActions } = load("src/components/Albums/AlbumActions.tsx", {
    "../../hooks/useAlbumManagement": { useAlbumManagement: () => management },
    "./AlbumActionsMenu": { AlbumActionsMenu: Menu },
    "./AlbumRenameModal": { AlbumRenameModal: RenameModal },
    "./AlbumDeleteConfirmDialog": { AlbumDeleteConfirmDialog: DeleteDialog },
  });
  const tree = AlbumActions({ album: { ...album, shared: true }, onDeleted() {} });
  const find = (type) => findAll(tree, (node) => node.type === type)[0];
  return { menu: find(Menu), rename: find(RenameModal), remove: find(DeleteDialog) };
}

test("choosing Delete album only opens the confirmation; removal needs the explicit confirm", () => {
  const calls = [];
  const management = {
    dialog: null,
    busy: false,
    error: null,
    online: true,
    openDialog: (kind) => calls.push(["open", kind]),
    closeDialog: () => calls.push(["close"]),
    rename: async (name) => calls.push(["rename", name]),
    remove: async () => calls.push(["remove"]),
  };

  const idle = mountActions(management);
  assert.equal(idle.rename, undefined);
  assert.equal(idle.remove, undefined);
  idle.menu.props.onDelete();
  idle.menu.props.onRename();
  assert.deepEqual(calls, [
    ["open", "delete"],
    ["open", "rename"],
  ]);

  calls.length = 0;
  const confirming = mountActions({ ...management, dialog: "delete" });
  assert.equal(confirming.rename, undefined);
  assert.equal(confirming.remove.props.albumName, "Holiday");
  assert.equal(confirming.remove.props.shared, true);
  confirming.remove.props.onClose();
  assert.deepEqual(calls, [["close"]], "cancelling never removes the album");
  confirming.remove.props.onConfirm();
  assert.deepEqual(calls, [["close"], ["remove"]]);

  calls.length = 0;
  const renaming = mountActions({ ...management, dialog: "rename" });
  assert.equal(renaming.remove, undefined);
  assert.equal(renaming.rename.props.currentName, "Holiday");
  renaming.rename.props.onSubmit("Summer");
  assert.deepEqual(calls, [["rename", "Summer"]]);
});

function mountDeleteDialog(props = {}) {
  const { AlbumDeleteConfirmDialog } = load("src/components/Albums/AlbumDeleteConfirmDialog.tsx", {
    react: { ...React, useRef: (current) => ({ current }), useEffect: () => {}, useId: () => "id" },
    "react-dom": { createPortal: (node) => node },
    "lucide-react": { TriangleAlert: () => null },
    "../../i18n": { useI18n: () => ({ t: (key) => key }) },
    "../../i18n/albumManagement": labelsDouble,
  });
  const calls = [];
  const tree = AlbumDeleteConfirmDialog({
    albumName: "Holiday",
    shared: false,
    online: true,
    busy: false,
    error: null,
    onConfirm: () => calls.push("confirm"),
    onClose: () => calls.push("close"),
    ...props,
  });
  const buttons = findAll(tree, (node) => node.type === "button");
  return {
    calls,
    text: textOf(tree),
    dialog: findAll(tree, (node) => node.type === "dialog")[0],
    confirm: buttons.find((button) => button.props.className.includes("btn-error")),
    cancel: buttons.find((button) => button.props.autoFocus),
  };
}

test("the delete dialog names the album, states the consequences and starts on Cancel", () => {
  const dialog = mountDeleteDialog();
  assert.match(dialog.text, /Holiday/);
  assert.match(dialog.text, /DELETE CONFIRM/);
  assert.doesNotMatch(dialog.text, /SHARED WARNING/);
  dialog.cancel.props.onClick();
  assert.deepEqual(dialog.calls, ["close"]);
  dialog.confirm.props.onClick();
  assert.deepEqual(dialog.calls, ["close", "confirm"]);
});

test("deleting a shared album warns that other people lose access", () => {
  assert.match(mountDeleteDialog({ shared: true }).text, /SHARED WARNING/);
});

test("the delete button is blocked while offline or deleting, and failures stay retryable", () => {
  const offline = mountDeleteDialog({ online: false });
  assert.equal(offline.confirm.props.disabled, true);
  assert.match(offline.text, /OFFLINE NOTICE/);

  const busy = mountDeleteDialog({ busy: true });
  assert.equal(busy.confirm.props.disabled, true);
  assert.equal(busy.cancel.props.disabled, true);
  assert.match(busy.text, /Deleting/);

  const failed = mountDeleteDialog({ error: "DELETE FAILED" });
  assert.match(failed.text, /DELETE FAILED/);
  assert.equal(failed.confirm.props.disabled, false);
});

test("Escape cancels the delete dialog unless a delete is in flight", () => {
  for (const [busy, expectedCalls] of [
    [false, ["close"]],
    [true, []],
  ]) {
    const dialog = mountDeleteDialog({ busy });
    let prevented = 0;
    dialog.dialog.props.onCancel({ preventDefault: () => (prevented += 1) });
    assert.equal(prevented, 1, "the native close is always intercepted");
    assert.deepEqual(dialog.calls, expectedCalls);
  }
});

function mountRenameModal(props = {}) {
  const host = createHookHost();
  const { AlbumRenameModal } = load("src/components/Albums/AlbumRenameModal.tsx", {
    react: host.hooks,
    "react-dom": { createPortal: (node) => node },
    "../../i18n": { useI18n: () => ({ t: (key) => key }) },
    "../../i18n/albumManagement": labelsDouble,
  });
  const submitted = [];
  let prevented = 0;
  const view = () => {
    const tree = host.run(() =>
      AlbumRenameModal({
        currentName: "Holiday",
        online: true,
        busy: false,
        error: null,
        onSubmit: (name) => submitted.push(name),
        onClose() {},
        ...props,
      }),
    );
    const form = findAll(tree, (node) => node.type === "form" && node.props.onSubmit)[0];
    return {
      text: textOf(tree),
      input: findAll(tree, (node) => node.type === "input")[0],
      save: findAll(tree, (node) => node.type === "button" && node.props.type === "submit")[0],
      submit: () => form.props.onSubmit({ preventDefault: () => (prevented += 1) }),
    };
  };
  return {
    view,
    submitted,
    prevented: () => prevented,
    type: (value) => view().input.props.onChange({ target: { value } }),
  };
}

test("the rename modal opens on the current name with nothing to save", () => {
  const modal = mountRenameModal();
  const view = modal.view();
  assert.equal(view.input.props.value, "Holiday");
  assert.equal(view.save.props.disabled, true);
  view.submit();
  assert.deepEqual(modal.submitted, []);
});

test("the rename modal submits the trimmed new name without navigating", () => {
  const modal = mountRenameModal();
  modal.type("  Summer 2024  ");
  const view = modal.view();
  assert.equal(view.input.props.value, "  Summer 2024  ");
  assert.equal(view.save.props.disabled, false);
  view.submit();
  assert.deepEqual(modal.submitted, ["Summer 2024"]);
  assert.equal(modal.prevented(), 1);
});

test("the rename modal refuses blank, unchanged and offline submissions", () => {
  const blank = mountRenameModal();
  blank.type("   ");
  assert.match(blank.view().text, /EMPTY NAME/);
  assert.equal(blank.view().save.props.disabled, true);
  blank.view().submit();

  const unchanged = mountRenameModal();
  unchanged.type(" Holiday ");
  assert.equal(unchanged.view().save.props.disabled, true);
  unchanged.view().submit();

  const offline = mountRenameModal({ online: false });
  offline.type("Summer");
  assert.match(offline.view().text, /OFFLINE NOTICE/);
  assert.equal(offline.view().save.props.disabled, true);
  offline.view().submit();

  assert.deepEqual(
    [blank, unchanged, offline].flatMap((modal) => modal.submitted),
    [],
  );
});

test("the rename modal locks the form while saving and shows server errors", () => {
  const saving = mountRenameModal({ busy: true });
  saving.type("Summer");
  const busyView = saving.view();
  assert.equal(busyView.input.props.disabled, true);
  assert.equal(busyView.save.props.disabled, true);
  assert.match(busyView.text, /Saving/);

  const failed = mountRenameModal({ error: "RENAME FAILED" });
  failed.type("Summer");
  assert.match(failed.view().text, /RENAME FAILED/);
  assert.equal(failed.view().save.props.disabled, false, "the user can retry");
});

test("the album header shows the actions menu right after Share, for the album owner only", () => {
  const page = read("src/pages/AlbumsPage.tsx");
  assert.match(page, /import \{ AlbumActions \} from "\.\.\/components\/Albums\/AlbumActions";/);
  const share = page.indexOf('{t("albums.shareAlbum")}');
  const actions = page.indexOf("<AlbumActions");
  assert.ok(share !== -1 && share < actions, "the menu follows the Share button");
  assert.doesNotMatch(page.slice(share, actions), /<button/, "nothing sits between them");
  assert.match(page, /selectedAlbum\.ownerId === session\.userId \? \(\s*<AlbumActions/);
  assert.match(
    page,
    /setSelectedAlbumId\(\(current\) =>\s*current === deletedAlbumId \? null : current/,
  );
});
