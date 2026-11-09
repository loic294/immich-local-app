import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function loadWindowLabel(getCurrentWindow) {
  const { outputText } = ts.transpileModule(read("../src/windows/windowLabel.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  runInNewContext(outputText, {
    exports,
    require(name) {
      assert.equal(name, "@tauri-apps/api/window", `Unexpected import: ${name}`);
      return { getCurrentWindow };
    },
  });
  return exports;
}

const rust = read("../src-tauri/src/activity_window.rs");
const rustLabel = (name) => rust.match(new RegExp(`const ${name}: &str = "([^"]+)";`))?.[1];

test("the TypeScript window labels match the Rust ones", () => {
  const labels = loadWindowLabel(() => ({ label: "main" }));
  assert.equal(labels.ACTIVITY_LOG_WINDOW_LABEL, rustLabel("WINDOW_LABEL"));
  assert.equal(labels.MAIN_WINDOW_LABEL, rustLabel("MAIN_WINDOW_LABEL"));
});

test("the main window label is the one declared in tauri.conf.json", () => {
  const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
  assert.equal(config.app.windows[0].label, loadWindowLabel(() => ({})).MAIN_WINDOW_LABEL);
});

test("currentWindowLabel reports the label of the current Tauri window", () => {
  const labels = loadWindowLabel(() => ({ label: "activity-log" }));
  assert.equal(labels.currentWindowLabel(), "activity-log");
  assert.equal(labels.isActivityLogWindow(), true);
});

test("outside Tauri the page counts as the main window", () => {
  const labels = loadWindowLabel(() => {
    throw new TypeError("Cannot read properties of undefined (reading 'metadata')");
  });
  assert.equal(labels.currentWindowLabel(), "main");
  assert.equal(labels.isActivityLogWindow(), false);
});

test("only the activity log label selects the log window", () => {
  const labels = loadWindowLabel(() => ({ label: "main" }));
  assert.equal(labels.isActivityLogWindow("activity-log"), true);
  assert.equal(labels.isActivityLogWindow("main"), false);
  assert.equal(labels.isActivityLogWindow("activity-log-2"), false);
  assert.equal(labels.isActivityLogWindow(""), false);
});

const staticImports = (source) =>
  [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const mainSource = read("../src/main.tsx");
const logWindowRoot = stripComments(read("../src/windows/ActivityLogWindowRoot.tsx"));
const mainWindowRoot = stripComments(read("../src/windows/MainWindowRoot.tsx"));

test("main.tsx picks the window root by label and loads each root on demand", () => {
  assert.match(mainSource, /isActivityLogWindow\(\)/);
  assert.match(mainSource, /import\("\.\/windows\/ActivityLogWindowRoot"\)/);
  assert.match(mainSource, /import\("\.\/windows\/MainWindowRoot"\)/);
  const eager = staticImports(mainSource);
  for (const path of [
    "./App",
    "./shortcuts/ShortcutProvider",
    "./windows/MainWindowRoot",
    "./windows/ActivityLogWindowRoot",
    "./components/ActivityLog/ActivityLogWindow",
  ]) {
    assert.ok(!eager.includes(path), `main.tsx must not import ${path} eagerly`);
  }
});

test("the activity log window never mounts the app, its shortcuts or the native menu handling", () => {
  const eager = staticImports(logWindowRoot);
  assert.ok(
    !eager.some((path) => /(^|\/)App$/.test(path)),
    "the log window root must not import App",
  );
  assert.doesNotMatch(logWindowRoot, /ShortcutProvider|ShortcutHost|useAppMenu/);
  assert.match(logWindowRoot, /<QueryClientProvider client=\{queryClient\}>/);
  assert.match(logWindowRoot, /<I18nProvider>\s*<ActivityLogWindow \/>\s*<\/I18nProvider>/);
});

test("the main window keeps its shortcut provider around the app", () => {
  assert.match(mainWindowRoot, /<QueryClientProvider client=\{queryClient\}>/);
  assert.match(
    mainWindowRoot,
    /<I18nProvider>\s*<ShortcutProvider>\s*<App \/>\s*<\/ShortcutProvider>\s*<\/I18nProvider>/,
  );
});

test("file logging and activity capture are set up before either window renders", () => {
  const fileLogging = mainSource.indexOf("setupFileLogging();");
  const capture = mainSource.indexOf("setupActivityCapture();");
  const render = mainSource.lastIndexOf("loadWindowRoot()");
  assert.ok(fileLogging >= 0 && capture > fileLogging, "capture must wrap the file logger");
  assert.ok(render > capture, "windows must render after capture is installed");
});
