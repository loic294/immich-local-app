import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const readSource = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;

function nodesMatching(root, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return matches;
}

function rootCallbacks(path, component = "Sidebar") {
  const source = ts.createSourceFile(
    path,
    readSource(path),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return nodesMatching(
    source,
    (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === component,
  ).flatMap((node) => {
    const attribute = node.attributes.properties.find(
      (property) => ts.isJsxAttribute(property) && property.name.text === "onNavigateRoot",
    );
    return attribute ? [attribute.initializer.expression.getText(source)] : [];
  });
}

function runCallback(callback, context) {
  runInNewContext(transpile(`(${callback})();`), {
    console: { info() {} },
    ...context,
  });
}

function renderSidebar(activePage, onNavigateRoot, group = "main") {
  const routes = [];
  const events = [];
  const storage = new Map();
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "lucide-react": {},
    react: { useEffect() {} },
    "./SyncStatusCard": { SyncStatusCard: "SyncStatusCard" },
    "../Albums/RecentAlbumsSection": { RecentAlbumsSection: "RecentAlbumsSection" },
    "./OfflineBanner": { OfflineBanner: "OfflineBanner" },
    "../../hooks/connectionContext": {
      useConnectionContext: () => ({ isOnline: false, pendingCount: 0 }),
    },
    "../../hooks/useSettings": {
      useSettings: () => ({
        data: {
          menuItems: ["albums", "calendar", "folders", "people", "photos", "maps"].map((key) => ({
            key,
            group,
          })),
        },
      }),
    },
    "../../i18n": { useI18n: () => ({ t: (key) => key }) },
    "../../assets/logo_with_title.svg": { default: "logo.svg" },
    "../../utils/platform": { isMacPlatform: () => false },
    "../../i18n/browsing": { useBrowsingI18n: () => (key) => key },
    "./SidebarButton": { SidebarButton: "SidebarButton" },
    "../../hooks/useRecentAlbums": { useRecentAlbums: () => ({ data: [{ id: "recent" }] }) },
  };
  runInNewContext(transpile(readSource("components/Layout/Sidebar.tsx")), {
    exports,
    require: (name) => {
      assert.ok(name in modules, `unexpected import: ${name}`);
      return modules[name];
    },
    window: { dispatchEvent: (event) => events.push(event) },
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    sessionStorage: { setItem: (key, value) => storage.set(key, value) },
  });
  const tree = exports.Sidebar({
    activePage,
    activeAlbumId: "recent",
    onNavigate: (page) => routes.push(page),
    onNavigateRoot,
  });
  function find(type, node = tree) {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap((child) => find(type, child));
    return [...(node.type === type ? [node] : []), ...find(type, node.props?.children ?? null)];
  }
  return { find, routes, events, storage };
}

for (const group of ["main", "library"]) {
  for (const page of ["albums", "calendar", "folders", "people"]) {
    test(`${group} menu: reselecting ${page} invokes its root callback, other spaces keep routing`, () => {
      let resets = 0;
      const sidebar = renderSidebar(page, () => resets++, group);
      const buttons = sidebar.find("SidebarButton");
      buttons
        .find((button) => button.props.label === (page === "people" ? "people" : `nav.${page}`))
        .props.onClick();
      assert.equal(resets, 1);
      assert.deepEqual(sidebar.routes, []);
      buttons.find((button) => button.props.label === "nav.photos").props.onClick();
      assert.deepEqual(sidebar.routes, ["photos"]);
      assert.equal(resets, 1);
    });
  }
}

for (const activePage of ["albums", "people", "photos"]) {
  test(`recent album navigation from ${activePage} never requests a collection reset`, () => {
    let resets = 0;
    const sidebar = renderSidebar(activePage, () => resets++);
    sidebar.find("RecentAlbumsSection")[0].props.onOpenAlbum("album-target");
    assert.equal(resets, 0);
    assert.equal(sidebar.storage.get("immich:open-recent-album"), "album-target");
    assert.equal(sidebar.events[0].type, "immich:open-album");
    assert.equal(sidebar.events[0].detail, "album-target");
    assert.deepEqual(sidebar.routes, ["albums"]);
  });
}

test("albums reset matches back navigation and leaves collection search untouched at root", () => {
  const [callback] = rootCallbacks("pages/AlbumsPage.tsx");
  const updates = [];
  const context = {
    setSelectedAlbumId: (value) => updates.push(["album", value]),
    setSearchInput: (value) => updates.push(["search", value]),
  };
  runCallback(callback, { ...context, selectedAlbumId: "album-id" });
  assert.deepEqual(updates, [
    ["album", null],
    ["search", ""],
  ]);
  updates.length = 0;
  runCallback(callback, { ...context, selectedAlbumId: null });
  assert.deepEqual(updates, []);
});

test("calendar month menu uses the existing back callback; calendar root is a no-op", () => {
  const [root, month] = rootCallbacks("pages/CalendarPage.tsx");
  let backs = 0;
  runCallback(root, { onBack: () => backs++ });
  assert.equal(backs, 0);
  runCallback(month, { year: 2026, month: 10, onBack: () => backs++ });
  assert.equal(backs, 1);
});

test("folders jump directly to the configured base, not the parent or filesystem root", () => {
  const [callback] = rootCallbacks("pages/FoldersPage.tsx");
  for (const baseDirectory of ["/photos", "/C:/Users/Loic/Pictures"]) {
    const paths = [];
    const context = {
      baseDirectory,
      baseDirectoryLoaded: true,
      setCurrentPath: (path) => paths.push(path),
    };
    runCallback(callback, { ...context, currentPath: `${baseDirectory}/2026/october` });
    assert.deepEqual(paths, [baseDirectory]);
    paths.length = 0;
    runCallback(callback, { ...context, currentPath: baseDirectory });
    runCallback(callback, {
      ...context,
      currentPath: "/old-account/path",
      baseDirectoryLoaded: false,
    });
    assert.deepEqual(paths, []);
  }
});

test("people detail clears selection/dialog without resetting collection filters; root is a no-op", () => {
  const [detail] = rootCallbacks("pages/PeoplePage.tsx", "PhotosPage");
  const [root] = rootCallbacks("pages/PeoplePage.tsx");
  const updates = [];
  const context = {
    selected: { id: "person-id" },
    setSelected: (value) => updates.push(["person", value]),
    setAssigning: (value) => updates.push(["assigning", value]),
  };
  runCallback(detail, context);
  assert.deepEqual(updates, [
    ["person", null],
    ["assigning", null],
  ]);
  updates.length = 0;
  runCallback(root, context);
  assert.deepEqual(updates, []);
  assert.deepEqual(rootCallbacks("pages/PhotosPage.tsx"), ["onNavigateRoot"]);
});
