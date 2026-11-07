import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";

// A promise that never settles would hang the whole run (and the release build) instead
// of failing the one test.
const test = (name, run) => nodeTest(name, { timeout: 10_000 }, run);

// The modal portals into document.body; these tests only inspect the element tree.
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

// Lets every already-resolved promise (and what it chains to) run.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  const gate = {};
  gate.promise = new Promise((resolve, reject) => {
    gate.resolve = resolve;
    gate.reject = reject;
  });
  return gate;
}

function silenceLogs(t) {
  for (const level of ["info", "warn", "error"]) t.mock.method(console, level, () => {});
}

const sameDeps = (previous, next) =>
  previous !== undefined &&
  next !== undefined &&
  previous.length === next.length &&
  previous.every((dep, index) => Object.is(dep, next[index]));

// Hook host: state, refs and memoised values persist across renders, and effects run
// (after cleaning up their previous run) on flush(), the way a commit would.
function createHookHost() {
  const slots = [];
  let cursor = 0;
  let queued = [];
  const hooks = {
    ...React,
    useState(initial) {
      const slot = (slots[cursor] ??= { value: initial });
      cursor += 1;
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
        },
      ];
    },
    useRef(initial) {
      const slot = (slots[cursor] ??= { current: initial });
      cursor += 1;
      return slot;
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (slots[index] && sameDeps(slots[index].deps, deps)) return slots[index].value;
      slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useCallback: (callback, deps) => hooks.useMemo(() => callback, deps),
    useEffect(effect, deps) {
      const slot = (slots[cursor] ??= { ran: false });
      cursor += 1;
      if (!slot.ran || !sameDeps(slot.deps, deps)) queued.push({ slot, effect, deps });
    },
    useId: () => "id",
  };
  return {
    hooks,
    run(render) {
      cursor = 0;
      return render();
    },
    flush() {
      const effects = queued;
      queued = [];
      for (const { slot, effect, deps } of effects) {
        slot.cleanup?.();
        slot.cleanup = effect();
        slot.deps = deps;
        slot.ran = true;
      }
    },
    unmount() {
      for (const slot of slots) {
        slot?.cleanup?.();
        if (slot) slot.cleanup = undefined;
      }
    },
  };
}

const labelsFor = (locale) =>
  load("src/i18n/albumAccess.ts", {
    "./index": { useI18n: () => ({ locale }) },
  }).useAlbumAccessLabels();
// Every label renders as «key», so assertions can tell labels apart and spot a missing one.
const labels = Object.fromEntries(Object.keys(labelsFor("en-CA")).map((key) => [key, `«${key}»`]));
const labelsDouble = { useAlbumAccessLabels: () => labels };
const accessUtils = load("src/utils/albumAccess.ts");
const failureUtils = load("src/utils/albumFailure.ts");

const person = (id, name, email) => ({ id, name, email });
const member = (id, name, email, role) => ({ id, name, email, role });
const owner = person("owner-1", "Olivia Owner", "olivia@example.com");
const anaPerson = person("user-1", "Ana", "ana@example.com");
const benPerson = person("user-2", "Ben", "ben@example.com");
const cy = person("user-3", null, "cy@example.com");
const everyone = [owner, anaPerson, benPerson, cy];
const ana = member("user-1", "Ana", "ana@example.com", "editor");
const ben = member("user-2", "Ben", "ben@example.com", "editor");

test("an owner may only grant the editor and viewer permissions", () => {
  const { toAlbumUserRole } = accessUtils;
  assert.equal(toAlbumUserRole("editor"), "editor");
  assert.equal(toAlbumUserRole("viewer"), "viewer");
  for (const unknown of ["owner", "EDITOR", "", null]) {
    assert.equal(toAlbumUserRole(unknown), null);
  }
});

test("people are named by name, then email, then id", () => {
  const { personLabel, personDetail } = accessUtils;
  assert.equal(personLabel(person("u", " Ana ", "ana@example.com")), "Ana");
  assert.equal(personLabel(person("u", "  ", " ana@example.com ")), "ana@example.com");
  assert.equal(personLabel(person("u", null, null)), "u");

  assert.equal(personDetail(person("u", "Ana", " ana@example.com ")), "ana@example.com");
  assert.equal(personDetail(person("u", null, "ana@example.com")), null, "email is the name");
  assert.equal(personDetail(person("u", "a@x.io", "a@x.io")), null, "no repeated line");
  assert.equal(personDetail(person("u", "Ana", "  ")), null);
  assert.equal(personDetail(person("u", "Ana", null)), null);
});

test("only people who can still be added are offered", () => {
  const { addableUsers } = accessUtils;
  const result = addableUsers(everyone, "owner-1", [ana]);
  assert.deepEqual(
    result.map((candidate) => candidate.id),
    ["user-2", "user-3"],
  );
  assert.equal(everyone.length, 4, "the server's list is not modified");
  assert.deepEqual(addableUsers([], "owner-1", []), []);
  assert.deepEqual(addableUsers([owner], "owner-1", []), [], "the owner is never offered");
});

test("marking an album shared updates that album only and keeps the list when nothing changes", () => {
  const { markAlbumShared } = accessUtils;
  const albums = [
    { id: "a1", shared: false },
    { id: "a2", shared: false },
    { id: "a3", shared: true },
  ];
  const marked = markAlbumShared(albums, "a1");
  assert.deepEqual(marked, [
    { id: "a1", shared: true },
    { id: "a2", shared: false },
    { id: "a3", shared: true },
  ]);
  assert.equal(marked[1], albums[1], "untouched albums keep their identity");
  assert.equal(albums[0].shared, false, "the cached list is never mutated");
  assert.equal(markAlbumShared(albums, "a3"), albums, "already shared");
  assert.equal(markAlbumShared(albums, "missing"), albums, "not in the list");
  assert.equal(markAlbumShared(undefined, "a1"), undefined, "nothing cached yet");
});

test("offline failures are recognised whether Tauri rejects with a string or an Error", () => {
  const { isOfflineFailure, failureMessage } = failureUtils;
  assert.equal(isOfflineFailure("offline: no route"), true);
  assert.equal(isOfflineFailure(new Error("offline: no route")), true);
  const others = [
    "Album not found",
    new Error("HTTP 500"),
    " offline: x",
    { message: "offline: x" },
  ];
  for (const other of [...others, 42, null, undefined]) {
    assert.equal(isOfflineFailure(other), false);
  }
  assert.equal(failureMessage("offline: x", "fallback", "offline text"), "offline text");
  assert.equal(failureMessage(new Error("HTTP 500"), "fallback", "offline text"), "fallback");
});

test("album access labels exist for every locale with identical keys", () => {
  const english = labelsFor("en-CA");
  const french = labelsFor("fr-CA");
  assert.deepEqual(Object.keys(french).sort(), Object.keys(english).sort());
  for (const [key, value] of [...Object.entries(english), ...Object.entries(french)]) {
    assert.ok(value.trim().length > 0, `${key} has text`);
  }
});

test("the access wrappers invoke native commands that the app registers", async () => {
  const requests = [];
  const api = load("src/api/tauri.ts", {
    "@tauri-apps/api/core": {
      invoke: async (command, payload) => {
        requests.push([command, payload]);
      },
    },
    "@tauri-apps/api/webview": {},
    "./deletion": {},
    "./thumbnailQueue": { ThumbnailQueue: class {} },
  });
  await api.canManageAlbumSharing("album-1");
  await api.getAlbumShareUsers("album-1");
  await api.getAlbumShareableUsers("album-1");
  await api.addUserToAlbum("album-1", "user-1", "viewer");
  await api.updateAlbumUserRole("album-1", "user-1", "editor");
  await api.removeUserFromAlbum("album-1", "user-1");
  assert.deepEqual(requests, [
    ["can_manage_album_sharing", { albumId: "album-1" }],
    ["get_album_share_users", { albumId: "album-1" }],
    ["get_album_shareable_users", { albumId: "album-1" }],
    ["add_user_to_album", { albumId: "album-1", userId: "user-1", role: "viewer" }],
    ["update_album_user_role", { albumId: "album-1", userId: "user-1", role: "editor" }],
    ["remove_user_from_album", { albumId: "album-1", userId: "user-1" }],
  ]);

  const handlers = read("src-tauri/src/main.rs").split("generate_handler![")[1].split("]")[0];
  for (const [command] of requests) {
    assert.match(handlers, new RegExp(`\\b${command}\\b`), `${command} is registered`);
  }
});

function mountOwnerAccess({ isOnline = true, check = async () => true } = {}) {
  const host = createHookHost();
  const connection = { isOnline };
  const checked = [];
  const { useAlbumOwnerAccess } = load("src/hooks/useAlbumOwnerAccess.ts", {
    react: host.hooks,
    "../api/tauri": {
      canManageAlbumSharing: async (albumId) => {
        checked.push(albumId);
        return check(albumId);
      },
    },
    "../utils/albumFailure": failureUtils,
    "./connectionContext": { useConnectionContext: () => connection },
  });
  return {
    connection,
    checked,
    unmount: host.unmount,
    render(albumId, ownerId = "someone-else", userId = "me") {
      const access = host.run(() => useAlbumOwnerAccess(albumId, ownerId, userId));
      host.flush();
      return access;
    },
  };
}

test("no album means no ownership and no server check", async (t) => {
  silenceLogs(t);
  const hook = mountOwnerAccess();
  assert.equal(hook.render(null, null), "not-owner");
  await settle();
  assert.deepEqual(hook.checked, []);
});

test("the signed-in account's own albums are owned without asking the server", async (t) => {
  silenceLogs(t);
  const hook = mountOwnerAccess({ isOnline: false });
  assert.equal(hook.render("album-1", "me"), "owner");
  await settle();
  assert.deepEqual(hook.checked, []);
});

test("another account's album is being checked until the server answers", async (t) => {
  silenceLogs(t);
  for (const [answer, expected] of [
    [true, "owner"],
    [false, "not-owner"],
  ]) {
    const hook = mountOwnerAccess({ check: async () => answer });
    assert.equal(hook.render("album-1"), "checking");
    await settle();
    assert.equal(hook.render("album-1"), expected);
    assert.deepEqual(hook.checked, ["album-1"], "asked once, not on every render");
  }
});

test("the server is not asked while offline or before the first probe", async (t) => {
  silenceLogs(t);
  for (const isOnline of [false, null]) {
    const hook = mountOwnerAccess({ isOnline });
    assert.equal(hook.render("album-1"), "checking");
    await settle();
    assert.deepEqual(hook.checked, []);

    hook.connection.isOnline = true;
    assert.equal(hook.render("album-1"), "checking");
    await settle();
    assert.deepEqual(hook.checked, ["album-1"]);
    assert.equal(hook.render("album-1"), "owner");
  }
});

test("an unreachable server leaves the answer pending until a later probe succeeds", async (t) => {
  silenceLogs(t);
  let attempts = 0;
  const hook = mountOwnerAccess({
    check: async () => {
      attempts += 1;
      if (attempts === 1) throw "offline: server unreachable";
      return true;
    },
  });
  hook.render("album-1");
  await settle();
  assert.equal(hook.render("album-1"), "checking", "unreachable is not a verdict");

  hook.connection.isOnline = false;
  hook.render("album-1");
  hook.connection.isOnline = true;
  hook.render("album-1");
  await settle();
  assert.equal(hook.render("album-1"), "owner");
  assert.deepEqual(hook.checked, ["album-1", "album-1"]);
});

test("a server rejection means the account does not own the album", async (t) => {
  silenceLogs(t);
  for (const failure of ["Album not found", new Error("HTTP 500")]) {
    const hook = mountOwnerAccess({
      check: async () => {
        throw failure;
      },
    });
    hook.render("album-1");
    await settle();
    assert.equal(hook.render("album-1"), "not-owner");
  }
});

test("an answer about one album never applies to another", async (t) => {
  silenceLogs(t);
  const slow = deferred();
  const hook = mountOwnerAccess({
    check: (albumId) => (albumId === "album-1" ? slow.promise : Promise.resolve(false)),
  });
  hook.render("album-1");
  assert.equal(hook.render("album-2"), "checking", "switching albums drops the old answer");
  await settle();
  assert.equal(hook.render("album-2"), "not-owner");

  slow.resolve(true);
  await settle();
  assert.equal(hook.render("album-2"), "not-owner", "album-1's late answer is discarded");
  assert.equal(hook.render("album-1"), "checking", "album-2's answer is not reused");
});

test("unmounting drops a pending ownership answer", async (t) => {
  silenceLogs(t);
  const slow = deferred();
  const hook = mountOwnerAccess({ check: () => slow.promise });
  hook.render("album-1");
  hook.unmount();
  slow.resolve(true);
  await settle();
  assert.equal(console.info.mock.calls.length, 0, "no verdict was recorded");
});

function mountAccess({ isOnline = true, members = [], candidates = everyone, behavior = {} } = {}) {
  const host = createHookHost();
  const connection = { isOnline };
  const calls = [];
  const cacheWrites = [];
  const queryClient = {
    setQueryData: (queryKey, updater) => cacheWrites.push({ queryKey, updater }),
  };
  const api =
    (name, fallback) =>
    async (...args) => {
      calls.push([name, ...args]);
      return (behavior[name] ?? fallback)(...args);
    };
  const { useAlbumAccess } = load("src/hooks/useAlbumAccess.ts", {
    react: host.hooks,
    "@tanstack/react-query": { useQueryClient: () => queryClient },
    "../api/tauri": {
      getAlbumShareUsers: api("getAlbumShareUsers", () => members),
      getAlbumShareableUsers: api("getAlbumShareableUsers", () => candidates),
      updateAlbumUserRole: api("updateAlbumUserRole", () => undefined),
      addUserToAlbum: api("addUserToAlbum", () => undefined),
      removeUserFromAlbum: api("removeUserFromAlbum", () => undefined),
    },
    "../i18n/albumAccess": labelsDouble,
    "../utils/albumAccess": accessUtils,
    "../utils/albumFailure": failureUtils,
    "./connectionContext": { useConnectionContext: () => connection },
  });
  const state = () => {
    const current = host.run(() => useAlbumAccess("album-1", "owner-1"));
    host.flush();
    return current;
  };
  return {
    connection,
    // The two loads every successful open makes; later calls come after them.
    calls,
    cacheWrites,
    unmount: host.unmount,
    state,
    async ready() {
      state();
      await settle();
      return state();
    },
  };
}

test("the lists load once and the add list leaves out the owner and current members", async (t) => {
  silenceLogs(t);
  const hook = mountAccess({ members: [ana] });
  const initial = hook.state();
  assert.deepEqual([initial.loadState, initial.online, initial.members], ["loading", true, []]);

  await settle();
  const state = hook.state();
  assert.equal(state.loadState, "ready");
  assert.deepEqual(state.members, [ana]);
  assert.deepEqual(
    state.addable.map((candidate) => candidate.id),
    ["user-2", "user-3"],
  );
  assert.deepEqual(state.ownerPerson, owner);
  assert.deepEqual(hook.calls, [
    ["getAlbumShareUsers", "album-1"],
    ["getAlbumShareableUsers", "album-1"],
  ]);
});

test("nothing is requested until the server connection is confirmed", async (t) => {
  silenceLogs(t);
  for (const isOnline of [false, null]) {
    const hook = mountAccess({ isOnline });
    assert.equal(hook.state().online, false);
    await settle();
    assert.deepEqual(hook.calls, []);

    hook.connection.isOnline = true;
    hook.state();
    await settle();
    const state = hook.state();
    assert.deepEqual([state.online, state.loadState], [true, "ready"]);
  }
});

test("going offline keeps the loaded lists on screen and coming back reloads them", async (t) => {
  silenceLogs(t);
  const hook = mountAccess({ members: [ana] });
  await hook.ready();
  assert.equal(hook.calls.length, 2);

  hook.connection.isOnline = false;
  const offline = hook.state();
  assert.deepEqual([offline.online, offline.loadState, offline.members], [false, "ready", [ana]]);
  await settle();
  assert.equal(hook.calls.length, 2, "offline requests nothing");

  hook.connection.isOnline = true;
  hook.state();
  await settle();
  assert.equal(hook.calls.length, 4);
  assert.equal(hook.state().loadState, "ready");
});

test("an album that already has people is flagged as shared in the cached list", async (t) => {
  silenceLogs(t);
  const shared = mountAccess({ members: [ana] });
  await shared.ready();
  const [write] = shared.cacheWrites;
  assert.deepEqual(write.queryKey, ["albums"]);
  assert.deepEqual(
    write.updater([
      { id: "album-1", shared: false },
      { id: "album-2", shared: false },
    ]),
    [
      { id: "album-1", shared: true },
      { id: "album-2", shared: false },
    ],
  );

  const alone = mountAccess({ members: [] });
  await alone.ready();
  assert.deepEqual(alone.cacheWrites, [], "an unshared album is left alone");
});

test("a failed load shows a localized message, never the server's text, and can be retried", async (t) => {
  silenceLogs(t);
  const failures = [
    [new Error("HTTP 500: stack trace from the server"), labels.loadFailed],
    ["Album not found", labels.loadFailed],
    ["offline: Connect to the album's server.", labels.offline],
  ];
  for (const [failure, message] of failures) {
    let broken = failure;
    const hook = mountAccess({
      behavior: {
        getAlbumShareUsers: () => {
          if (broken) throw broken;
          return [ana];
        },
      },
    });
    const failed = await hook.ready();
    assert.deepEqual([failed.loadState, failed.error, failed.members], ["failed", message, []]);

    broken = null;
    await failed.reload();
    const retried = hook.state();
    assert.deepEqual([retried.loadState, retried.error, retried.members], ["ready", null, [ana]]);
  }
});

test("a late answer from a superseded load is ignored", async (t) => {
  silenceLogs(t);
  const answers = [deferred(), deferred()];
  const [first, second] = answers;
  const hook = mountAccess({ behavior: { getAlbumShareUsers: () => answers.shift().promise } });
  hook.state();
  const reload = hook.state().reload();
  second.resolve([ben]);
  await reload;
  first.resolve([ana]);
  await settle();
  assert.deepEqual(hook.state().members, [ben]);
});

test("unmounting drops a load that is still in flight", async (t) => {
  silenceLogs(t);
  const answer = deferred();
  const hook = mountAccess({ behavior: { getAlbumShareUsers: () => answer.promise } });
  hook.state();
  hook.unmount();
  answer.resolve([ana]);
  await settle();
  const state = hook.state();
  assert.deepEqual([state.loadState, state.members], ["loading", []]);
});

test("changing a permission updates only that person once the server confirms it", async (t) => {
  silenceLogs(t);
  const answer = deferred();
  const hook = mountAccess({
    members: [ana, ben],
    behavior: { updateAlbumUserRole: () => answer.promise },
  });
  await hook.ready();

  const change = hook.state().changeRole("user-1", "viewer");
  const inFlight = hook.state();
  assert.deepEqual(
    [inFlight.workingUserId, inFlight.busy, inFlight.adding],
    ["user-1", true, false],
  );
  assert.equal(inFlight.members[0].role, "editor", "unchanged until the server confirms");

  answer.resolve();
  await change;
  const state = hook.state();
  assert.deepEqual(
    state.members.map((item) => [item.id, item.role]),
    [
      ["user-1", "viewer"],
      ["user-2", "editor"],
    ],
  );
  assert.deepEqual([state.workingUserId, state.busy, state.error], [null, false, null]);
  assert.deepEqual(hook.calls.slice(2), [["updateAlbumUserRole", "album-1", "user-1", "viewer"]]);
});

test("a failed permission change keeps the previous permission and says why", async (t) => {
  silenceLogs(t);
  const failures = [
    ["offline: Connect to the album's server.", labels.offline],
    [new Error("HTTP 403: forbidden"), labels.updateFailed],
  ];
  for (const [failure, message] of failures) {
    const hook = mountAccess({
      members: [ana],
      behavior: {
        updateAlbumUserRole: () => {
          throw failure;
        },
      },
    });
    await hook.ready();
    await hook.state().changeRole("user-1", "viewer");
    const state = hook.state();
    assert.equal(state.members[0].role, "editor");
    assert.deepEqual([state.error, state.busy, state.workingUserId], [message, false, null]);
  }
});

test("only one permission change runs at a time", async (t) => {
  silenceLogs(t);
  const answer = deferred();
  const hook = mountAccess({
    members: [ana, ben],
    behavior: { updateAlbumUserRole: () => answer.promise },
  });
  await hook.ready();

  // None of these are awaited before the gate opens: a change that wrongly went through
  // would wait on the gate forever and hang the run instead of failing it.
  const first = hook.state().changeRole("user-1", "viewer");
  const others = [
    hook.state().changeRole("user-2", "viewer"),
    hook.state().removeUser("user-2"),
    hook.state().addUser("user-3", "viewer"),
  ];
  await settle();
  assert.deepEqual(hook.calls.slice(2), [["updateAlbumUserRole", "album-1", "user-1", "viewer"]]);

  answer.resolve();
  await first;
  const [, , added] = await Promise.all(others);
  assert.equal(added, false, "adding is refused while another change is in flight");
  await hook.state().changeRole("user-2", "viewer");
  assert.equal(hook.calls.length, 4, "the next change goes through once the first finished");
});

test("adding a person grants the chosen permission, lists them and flags the album as shared", async (t) => {
  silenceLogs(t);
  const answer = deferred();
  const hook = mountAccess({ behavior: { addUserToAlbum: () => answer.promise } });
  const loaded = await hook.ready();
  assert.deepEqual(
    loaded.addable.map((candidate) => candidate.id),
    ["user-1", "user-2", "user-3"],
    "everyone but the owner",
  );

  const adding = hook.state().addUser("user-2", "viewer");
  const inFlight = hook.state();
  assert.deepEqual([inFlight.adding, inFlight.busy, inFlight.workingUserId], [true, true, null]);

  answer.resolve();
  assert.equal(await adding, true);
  const state = hook.state();
  assert.deepEqual(state.members, [
    { id: "user-2", name: "Ben", email: "ben@example.com", role: "viewer" },
  ]);
  assert.deepEqual(
    state.addable.map((candidate) => candidate.id),
    ["user-1", "user-3"],
  );
  assert.deepEqual([state.adding, state.busy, state.error], [false, false, null]);
  assert.deepEqual(hook.calls.slice(2), [["addUserToAlbum", "album-1", "user-2", "viewer"]]);
  const [write] = hook.cacheWrites;
  assert.deepEqual(write.queryKey, ["albums"]);
  assert.deepEqual(write.updater([{ id: "album-1", shared: false }]), [
    { id: "album-1", shared: true },
  ]);
});

test("a failed add changes nothing and says why", async (t) => {
  silenceLogs(t);
  const failures = [
    ["offline: Connect to the album's server.", labels.offline],
    [new Error("HTTP 400: duplicate"), labels.addFailed],
  ];
  for (const [failure, message] of failures) {
    const hook = mountAccess({
      behavior: {
        addUserToAlbum: () => {
          throw failure;
        },
      },
    });
    await hook.ready();
    assert.equal(await hook.state().addUser("user-2", "editor"), false);
    const state = hook.state();
    assert.deepEqual(
      [state.members, state.error, state.adding, state.busy],
      [[], message, false, false],
    );
    assert.equal(state.addable.length, 3);
    assert.deepEqual(hook.cacheWrites, []);
  }
});

test("removing a person closes the confirmation only once the server confirms it", async (t) => {
  silenceLogs(t);
  let failure = new Error("HTTP 500: boom");
  const hook = mountAccess({
    members: [ana, ben],
    behavior: {
      removeUserFromAlbum: () => {
        if (failure) throw failure;
      },
    },
  });
  await hook.ready();

  hook.state().requestRemoval("user-1");
  assert.equal(hook.state().pendingRemovalId, "user-1");
  assert.deepEqual(hook.calls.slice(2), [], "asking does not remove anyone");

  await hook.state().removeUser("user-1");
  let state = hook.state();
  assert.deepEqual([state.pendingRemovalId, state.error], ["user-1", labels.removeFailed]);
  assert.equal(state.members.length, 2);

  failure = null;
  await hook.state().removeUser("user-1");
  state = hook.state();
  assert.deepEqual([state.pendingRemovalId, state.error], [null, null]);
  assert.deepEqual(state.members, [ben]);
  assert.ok(
    state.addable.some((candidate) => candidate.id === "user-1"),
    "they can be added again",
  );
  assert.deepEqual(
    hook.calls.slice(2).map(([name]) => name),
    ["removeUserFromAlbum", "removeUserFromAlbum"],
  );
});

test("cancelling a removal clears the question and any earlier error", async (t) => {
  silenceLogs(t);
  const hook = mountAccess({
    members: [ana],
    behavior: {
      removeUserFromAlbum: () => {
        throw new Error("HTTP 500");
      },
    },
  });
  await hook.ready();
  hook.state().requestRemoval("user-1");
  await hook.state().removeUser("user-1");
  assert.equal(hook.state().error, labels.removeFailed);

  hook.state().requestRemoval(null);
  const state = hook.state();
  assert.deepEqual([state.pendingRemovalId, state.error], [null, null]);
});

function mountRow(initial = {}) {
  const host = createHookHost();
  const { AlbumAccessUserRow } = load("src/components/Albums/AlbumAccessUserRow.tsx", {
    react: host.hooks,
    "../../i18n/albumAccess": labelsDouble,
    "../../utils/albumAccess": accessUtils,
  });
  const calls = [];
  const focused = [];
  let props = {
    member: ana,
    working: false,
    locked: false,
    confirmingRemoval: false,
    onRoleChange: (role) => calls.push(["role", role]),
    onRequestRemoval: () => calls.push(["request"]),
    onCancelRemoval: () => calls.push(["cancel"]),
    onConfirmRemoval: () => calls.push(["confirm"]),
    ...initial,
  };
  const view = () => {
    const tree = host.run(() => AlbumAccessUserRow(props));
    // Stand-in DOM nodes, so the focus handoff can be observed.
    for (const node of findAll(tree, (candidate) => candidate.ref)) {
      node.ref.current = { focus: () => focused.push(textOf(node)) };
    }
    host.flush();
    return {
      tree,
      text: textOf(tree),
      select: findAll(tree, (node) => node.type === "select")[0],
      buttons: findAll(tree, (node) => node.type === "button"),
    };
  };
  return {
    view,
    calls,
    focused,
    update: (next) => {
      props = { ...props, ...next };
    },
  };
}

const optionsOf = (select) => findAll(select, (node) => node.type === "option");

test("a row shows the person's name, email and permission", () => {
  const view = mountRow().view();
  assert.match(view.text, /Ana/);
  assert.match(view.text, /ana@example\.com/);
  assert.equal(view.select.props.value, "editor");
  assert.equal(view.select.props["aria-label"], "Ana – «permission»");
  assert.deepEqual(
    optionsOf(view.select).map((option) => [option.props.value, textOf(option)]),
    [
      ["editor", "«editor»"],
      ["viewer", "«viewer»"],
    ],
  );
});

test("a row without a name shows the email once, and without either shows the id", () => {
  const byEmail = mountRow({ member: member("user-3", null, "cy@example.com", "viewer") }).view();
  assert.equal(byEmail.text.split("cy@example.com").length - 1, 1);
  const byId = mountRow({ member: member("user-9", null, null, "viewer") }).view();
  assert.match(byId.text, /user-9/);
});

test("choosing another permission reports it; the same or an unknown one does not", () => {
  const row = mountRow();
  const { select } = row.view();
  for (const value of ["viewer", "editor", "", "owner"]) {
    select.props.onChange({ target: { value } });
  }
  assert.deepEqual(row.calls, [["role", "viewer"]]);
});

test("a permission the app does not know is shown as is and can be replaced", () => {
  for (const [role, shown] of [
    ["co-owner", "co-owner"],
    [null, "—"],
  ]) {
    const row = mountRow({ member: { ...ana, role } });
    const { select } = row.view();
    assert.equal(select.props.value, role ?? "");
    const [unknown, ...known] = optionsOf(select);
    assert.equal(unknown.props.disabled, true);
    assert.equal(textOf(unknown), shown);
    assert.deepEqual(
      known.map((option) => option.props.value),
      ["editor", "viewer"],
    );
    select.props.onChange({ target: { value: "viewer" } });
    assert.deepEqual(row.calls, [["role", "viewer"]]);
  }
});

test("a row locks while its own change or another change is in flight", () => {
  const idle = mountRow().view();
  assert.deepEqual([idle.select.props.disabled, idle.buttons[0].props.disabled], [false, false]);
  assert.equal(idle.tree.props["aria-busy"], false);

  for (const props of [{ working: true }, { locked: true }]) {
    const view = mountRow(props).view();
    assert.equal(view.select.props.disabled, true);
    assert.equal(view.buttons[0].props.disabled, true);
  }
  assert.equal(mountRow({ working: true }).view().tree.props["aria-busy"], true);
});

test("removal asks for confirmation before anything is removed", () => {
  const row = mountRow();
  const view = row.view();
  assert.equal(view.buttons.length, 1);
  assert.equal(view.buttons[0].props["aria-label"], "«remove» – Ana");
  assert.doesNotMatch(view.text, /«removeConfirm»/);
  view.buttons[0].props.onClick();
  assert.deepEqual(row.calls, [["request"]]);

  const confirming = mountRow({ confirmingRemoval: true });
  const confirmView = confirming.view();
  assert.match(confirmView.text, /«removeConfirm»/);
  assert.equal(confirmView.select.props.disabled, true, "permission is frozen while confirming");
  const confirm = confirmView.buttons.find((button) =>
    button.props.className.includes("btn-error"),
  );
  const cancel = confirmView.buttons.find((button) => textOf(button) === "«cancel»");
  assert.equal(confirm.props["aria-label"], "«remove» – Ana");
  cancel.props.onClick();
  confirm.props.onClick();
  assert.deepEqual(confirming.calls, [["cancel"], ["confirm"]]);
});

test("a confirmation in progress blocks both choices, and a locked one only blocks removing", () => {
  const spinners = (button) =>
    findAll(button, (node) => node.type === "span" && node.props.className.includes("loading"));
  const buttonsOf = (props) => {
    const view = mountRow({ confirmingRemoval: true, ...props }).view();
    return {
      confirm: view.buttons.find((button) => button.props.className.includes("btn-error")),
      cancel: view.buttons.find((button) => textOf(button) === "«cancel»"),
    };
  };

  const working = buttonsOf({ working: true });
  assert.deepEqual([working.confirm.props.disabled, working.cancel.props.disabled], [true, true]);
  assert.equal(spinners(working.confirm).length, 1, "the removal shows progress");

  const locked = buttonsOf({ locked: true });
  assert.deepEqual([locked.confirm.props.disabled, locked.cancel.props.disabled], [true, false]);
  assert.equal(spinners(locked.confirm).length, 0);

  const ready = buttonsOf({});
  assert.deepEqual([ready.confirm.props.disabled, ready.cancel.props.disabled], [false, false]);
});

test("removal confirmation hands focus to Cancel and back to Remove", () => {
  const row = mountRow();
  row.view();
  assert.deepEqual(row.focused, [], "nothing steals focus on mount");

  row.update({ confirmingRemoval: true });
  row.view();
  assert.deepEqual(row.focused, ["«cancel»"]);

  row.update({ confirmingRemoval: false });
  row.view();
  assert.deepEqual(row.focused, ["«cancel»", "«remove»"]);
});

function mountAddUser({ succeeds = true, ...initial } = {}) {
  const host = createHookHost();
  const { AlbumAccessAddUser } = load("src/components/Albums/AlbumAccessAddUser.tsx", {
    react: host.hooks,
    "../../i18n/albumAccess": labelsDouble,
    "../../utils/albumAccess": accessUtils,
  });
  const added = [];
  let prevented = 0;
  let props = {
    candidates: [benPerson, cy],
    adding: false,
    locked: false,
    onAdd: async (userId, role) => {
      added.push([userId, role]);
      return succeeds;
    },
    ...initial,
  };
  const view = () => {
    const tree = host.run(() => AlbumAccessAddUser(props));
    const [personSelect, roleSelect] = findAll(tree, (node) => node.type === "select");
    return {
      text: textOf(tree),
      personSelect,
      roleSelect,
      submitButton: findAll(tree, (node) => node.type === "button")[0],
      async submit() {
        tree.props.onSubmit({ preventDefault: () => (prevented += 1) });
        await settle();
      },
    };
  };
  return {
    view,
    added,
    prevented: () => prevented,
    update: (next) => {
      props = { ...props, ...next };
    },
  };
}

test("the add form offers each candidate by name and starts with nothing chosen", () => {
  const view = mountAddUser().view();
  assert.equal(view.personSelect.props.value, "");
  assert.deepEqual(
    optionsOf(view.personSelect).map((option) => [option.props.value, textOf(option)]),
    [
      ["", "«selectPerson»"],
      ["user-2", "Ben"],
      ["user-3", "cy@example.com"],
    ],
  );
  assert.equal(view.roleSelect.props.value, "editor");
  assert.equal(view.submitButton.props.disabled, true);
  assert.match(view.text, /«add»/);
});

test("choosing a person and a permission adds them, then clears the choice", async () => {
  const form = mountAddUser();
  form.view().personSelect.props.onChange({ target: { value: "user-2" } });
  form.view().roleSelect.props.onChange({ target: { value: "viewer" } });
  const ready = form.view();
  assert.deepEqual(
    [
      ready.personSelect.props.value,
      ready.roleSelect.props.value,
      ready.submitButton.props.disabled,
    ],
    ["user-2", "viewer", false],
  );

  await ready.submit();
  assert.deepEqual(form.added, [["user-2", "viewer"]]);
  assert.equal(form.prevented(), 1, "the form never navigates");
  assert.equal(form.view().personSelect.props.value, "");
});

test("a failed add keeps the choice so it can be retried", async () => {
  const form = mountAddUser({ succeeds: false });
  form.view().personSelect.props.onChange({ target: { value: "user-3" } });
  await form.view().submit();
  assert.deepEqual(form.added, [["user-3", "editor"]]);
  const view = form.view();
  assert.equal(view.personSelect.props.value, "user-3");
  assert.equal(view.submitButton.props.disabled, false);
});

test("the add form refuses to submit without a choice, while adding, or when locked", async () => {
  for (const [props, choose] of [
    [{}, false],
    [{ adding: true }, true],
    [{ locked: true }, true],
  ]) {
    const form = mountAddUser(props);
    if (choose) form.view().personSelect.props.onChange({ target: { value: "user-2" } });
    const view = form.view();
    assert.equal(view.submitButton.props.disabled, true);
    await view.submit();
    assert.deepEqual(form.added, []);
  }
});

test("the add form's controls are disabled while adding or locked", () => {
  const adding = mountAddUser({ adding: true }).view();
  assert.deepEqual(
    [adding.personSelect, adding.roleSelect, adding.submitButton].map(
      (item) => item.props.disabled,
    ),
    [true, true, true],
  );
  assert.match(adding.text, /«adding»/);
  assert.doesNotMatch(adding.text, /«add»/);

  const locked = mountAddUser({ locked: true }).view();
  assert.deepEqual(
    [locked.personSelect, locked.roleSelect, locked.submitButton].map(
      (item) => item.props.disabled,
    ),
    [true, true, true],
  );
  assert.match(locked.text, /«add»/);
});

test("with nobody left to add the form says so instead of offering controls", () => {
  const view = mountAddUser({ candidates: [] }).view();
  assert.match(view.text, /«noCandidates»/);
  assert.equal(view.personSelect, undefined);
  assert.equal(view.submitButton, undefined);
});

test("a chosen person who disappears from the list is no longer selected", async () => {
  const form = mountAddUser();
  form.view().personSelect.props.onChange({ target: { value: "user-2" } });
  form.update({ candidates: [cy] });
  const view = form.view();
  assert.equal(view.personSelect.props.value, "");
  assert.equal(view.submitButton.props.disabled, true);
  await view.submit();
  assert.deepEqual(form.added, []);
});

function mountModal({ access = {}, props = {} } = {}) {
  const host = createHookHost();
  const calls = [];
  const closed = [];
  const UserRow = function AlbumAccessUserRow() {
    return null;
  };
  const AddUser = function AlbumAccessAddUser() {
    return null;
  };
  const state = {
    online: true,
    loadState: "ready",
    members: [],
    addable: [],
    ownerPerson: null,
    workingUserId: null,
    adding: false,
    busy: false,
    pendingRemovalId: null,
    error: null,
    reload: () => calls.push(["reload"]),
    changeRole: (...args) => calls.push(["changeRole", ...args]),
    addUser: (...args) => calls.push(["addUser", ...args]),
    requestRemoval: (...args) => calls.push(["requestRemoval", ...args]),
    removeUser: (...args) => calls.push(["removeUser", ...args]),
    ...access,
  };
  const { AlbumAccessModal } = load("src/components/Albums/AlbumAccessModal.tsx", {
    react: host.hooks,
    "react-dom": { createPortal: (node) => node },
    "../../hooks/useAlbumAccess": { useAlbumAccess: () => state },
    "../../i18n/albumAccess": labelsDouble,
    "../../utils/albumAccess": accessUtils,
    "./AlbumAccessAddUser": { AlbumAccessAddUser: AddUser },
    "./AlbumAccessUserRow": { AlbumAccessUserRow: UserRow },
  });
  const dialog = {
    shown: 0,
    closed: 0,
    showModal() {
      this.shown += 1;
    },
    close() {
      this.closed += 1;
    },
  };
  const view = () => {
    const tree = host.run(() =>
      AlbumAccessModal({
        albumId: "album-1",
        albumName: "Holiday",
        ownerId: "owner-1",
        owner,
        onClose: () => closed.push("closed"),
        ...props,
      }),
    );
    tree.ref.current = dialog;
    host.flush();
    return {
      tree,
      text: textOf(tree),
      rows: findAll(tree, (node) => node.type === UserRow),
      addForm: findAll(tree, (node) => node.type === AddUser)[0],
      alerts: findAll(tree, (node) => node.props.role === "alert"),
      statuses: findAll(tree, (node) => node.props.role === "status"),
      buttons: (text) => findAll(tree, (node) => node.type === "button" && textOf(node) === text),
    };
  };
  return { view, access: state, calls, closed, dialog, unmount: host.unmount };
}

test("the access modal lists the owner, each person with access and the add form", () => {
  const modal = mountModal({ access: { members: [ana, ben], addable: [cy] } });
  const view = modal.view();
  for (const expected of [/«title»/, /Holiday/, /Olivia Owner/, /olivia@example\.com/, /«owner»/]) {
    assert.match(view.text, expected);
  }
  assert.match(view.text, /«peopleHeading»/);
  assert.match(view.text, /«roleHelp»/);
  assert.doesNotMatch(view.text, /«noPeople»/);
  assert.deepEqual(
    view.rows.map((row) => row.props.member),
    [ana, ben],
  );
  assert.deepEqual(
    view.rows.map((row) => [row.props.working, row.props.locked, row.props.confirmingRemoval]),
    [
      [false, false, false],
      [false, false, false],
    ],
  );
  assert.deepEqual(view.addForm.props.candidates, [cy]);
  assert.deepEqual([view.addForm.props.adding, view.addForm.props.locked], [false, false]);
  assert.equal(view.addForm.props.onAdd, modal.access.addUser);
  assert.deepEqual(view.alerts, []);
});

test("the rows are wired to the access actions", () => {
  const modal = mountModal({ access: { members: [ana], pendingRemovalId: "user-1" } });
  const [row] = modal.view().rows;
  assert.equal(row.props.confirmingRemoval, true);
  row.props.onRoleChange("viewer");
  row.props.onRequestRemoval();
  row.props.onCancelRemoval();
  row.props.onConfirmRemoval();
  assert.deepEqual(modal.calls, [
    ["changeRole", "user-1", "viewer"],
    ["requestRemoval", "user-1"],
    ["requestRemoval", null],
    ["removeUser", "user-1"],
  ]);
});

test("every control locks while a change is in flight and only that person's row shows progress", () => {
  const changing = mountModal({
    access: { members: [ana, ben], workingUserId: "user-2", busy: true },
  }).view();
  assert.deepEqual(
    changing.rows.map((row) => [row.props.working, row.props.locked]),
    [
      [false, true],
      [true, true],
    ],
  );
  assert.equal(changing.addForm.props.locked, true);

  const adding = mountModal({ access: { members: [ana], adding: true, busy: true } }).view();
  assert.deepEqual([adding.addForm.props.adding, adding.addForm.props.locked], [true, true]);
  assert.deepEqual(
    adding.rows.map((row) => row.props.working),
    [false],
  );
});

test("closing is blocked while a change is in flight", () => {
  const idle = mountModal();
  const idleView = idle.view();
  assert.equal(idleView.buttons("«close»").length, 2, "the button and the backdrop");
  for (const closer of idleView.buttons("«close»")) closer.props.onClick();
  assert.deepEqual(idle.closed, ["closed", "closed"]);
  assert.equal(idleView.tree.props["aria-busy"], false);

  const busy = mountModal({ access: { members: [ana], workingUserId: "user-1", busy: true } });
  const busyView = busy.view();
  assert.ok(busyView.buttons("«close»").every((closer) => closer.props.disabled === true));
  assert.equal(busyView.tree.props["aria-busy"], true);
});

test("Escape closes the modal unless a change is in flight, and never closes the dialog itself", () => {
  let prevented = 0;
  const event = { preventDefault: () => (prevented += 1) };
  const idle = mountModal();
  idle.view().tree.props.onCancel(event);
  assert.deepEqual(idle.closed, ["closed"]);

  const busy = mountModal({ access: { busy: true } });
  busy.view().tree.props.onCancel(event);
  assert.deepEqual(busy.closed, []);
  assert.equal(prevented, 2);
});

test("keys pressed in the modal do not reach the views underneath", () => {
  let stopped = 0;
  mountModal()
    .view()
    .tree.props.onKeyDown({ stopPropagation: () => (stopped += 1) });
  assert.equal(stopped, 1);
});

test("the modal opens as a native modal dialog and closes it when it unmounts", () => {
  const modal = mountModal();
  modal.view();
  modal.view();
  assert.equal(modal.dialog.shown, 1, "opened once, not on every render");
  assert.equal(modal.dialog.closed, 0);
  modal.unmount();
  assert.equal(modal.dialog.closed, 1);
});

test("while the lists load the modal shows progress and nothing to act on", () => {
  const view = mountModal({ access: { loadState: "loading" } }).view();
  assert.deepEqual(view.statuses.map(textOf), ["«loading»"]);
  assert.deepEqual(view.rows, []);
  assert.equal(view.addForm, undefined);
  assert.doesNotMatch(view.text, /«peopleHeading»|«owner»/);
});

test("a failed load shows the error with a retry that reloads", () => {
  const modal = mountModal({ access: { loadState: "failed", error: labels.loadFailed } });
  const view = modal.view();
  assert.deepEqual(view.alerts.map(textOf), ["«loadFailed»"]);
  assert.deepEqual(view.rows, []);
  assert.equal(view.addForm, undefined);
  const [retry] = view.buttons("«retry»");
  retry.props.onClick();
  assert.deepEqual(modal.calls, [["reload"]]);
});

test("offline, the modal explains why it is read-only and locks every control", () => {
  const readOnly = mountModal({
    access: {
      online: false,
      members: [ana],
      addable: [cy],
      error: labels.offline,
    },
  }).view();
  assert.deepEqual(readOnly.statuses.map(textOf), ["«offline»"]);
  assert.deepEqual(readOnly.alerts, [], "the offline message is not repeated as an error");
  assert.deepEqual(
    readOnly.rows.map((row) => row.props.locked),
    [true],
  );
  assert.equal(readOnly.addForm.props.locked, true);

  const neverLoaded = mountModal({ access: { online: false, loadState: "loading" } }).view();
  assert.deepEqual(neverLoaded.statuses.map(textOf), ["«offline»"]);
  assert.deepEqual(neverLoaded.rows, []);
  assert.doesNotMatch(neverLoaded.text, /«loading»/);

  const otherError = mountModal({ access: { online: false, error: labels.updateFailed } }).view();
  assert.deepEqual(otherError.alerts.map(textOf), ["«updateFailed»"]);
});

test("a failed change shows its error under the lists, which stay on screen", () => {
  const view = mountModal({ access: { members: [ana], error: labels.updateFailed } }).view();
  assert.deepEqual(view.alerts.map(textOf), ["«updateFailed»"]);
  assert.equal(view.rows.length, 1);
  assert.ok(view.addForm);

  const unreachable = mountModal({ access: { error: labels.offline } }).view();
  assert.deepEqual(
    unreachable.alerts.map(textOf),
    ["«offline»"],
    "an unreachable server is still reported while the connection check says online",
  );
});

test("the owner row falls back to the server's user record, then to the id", () => {
  const fromServer = mountModal({
    props: { owner: null },
    access: { ownerPerson: person("owner-1", "Olivia From Server", null) },
  }).view();
  assert.match(fromServer.text, /Olivia From Server/);

  const bare = mountModal({ props: { owner: null } }).view();
  assert.match(bare.text, /owner-1/);
});

test("an album nobody else can see says so but still offers to add someone", () => {
  const view = mountModal({ access: { members: [], addable: [benPerson] } }).view();
  assert.match(view.text, /«noPeople»/);
  assert.match(view.text, /«owner»/);
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.addForm.props.candidates, [benPerson]);
});
