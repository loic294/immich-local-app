import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const calls = [];
globalThis.window = new EventTarget();
globalThis.window.setInterval = () => 1;
globalThis.window.clearInterval = () => {};
globalThis.CustomEvent = class extends Event {
  constructor(type, { detail } = {}) {
    super(type);
    this.detail = detail;
  }
};
globalThis.__editInvoke = async (command, args) => {
  calls.push({ command, args });
  return [];
};
globalThis.__editConvert = (path) => {
  calls.push({ command: "convertFileSrc", path });
  return `asset://safe/${encodeURIComponent(path)}`;
};
const source = readFileSync(new URL("../src/api/media.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const api = await import(
  `data:text/javascript;base64,${Buffer.from(
    outputText.replace(
      /import \{ convertFileSrc, invoke \} from "@tauri-apps\/api\/core";/,
      "const invoke = (...args) => globalThis.__editInvoke(...args); const convertFileSrc = globalThis.__editConvert;",
    ),
  ).toString("base64")}`
);

test("explicit confirmation, not process exit or sidecar detection, completes a session", () => {
  let launches = 0;
  let finishes = 0;
  window.addEventListener("media:edit-request", () => launches++);
  window.addEventListener("media:finish-edit", () => finishes++);
  api.requestMediaEdit(["original"]);
  assert.equal(api.getMediaEditState().phase, "launching");
  api.requestMediaEdit(["original"]);
  api.requestMediaEdit(["another"]);
  api.requestFinishMediaEdit();
  assert.equal(launches, 1);
  assert.equal(finishes, 0, "cannot finish before launch succeeds");
  api.updateMediaEditState({ phase: "editing" });
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("media:editor-exited"));
  assert.equal(api.getMediaEditState().phase, "editing");
  api.requestFinishMediaEdit();
  api.requestFinishMediaEdit();
  assert.equal(finishes, 1);
  assert.equal(api.getMediaEditState().phase, "finishing");
  api.updateMediaEditState({ phase: "editing" });
  api.requestFinishMediaEdit();
  assert.equal(finishes, 2, "a failed final scan remains retryable");
  api.updateMediaEditState({ phase: "idle", assetIds: [] });
});

test("launch failure can reset busy and permit a new launch", () => {
  api.requestMediaEdit(["original"]);
  api.updateMediaEditState({ phase: "idle", assetIds: [] });
  api.requestMediaEdit(["original"]);
  assert.equal(api.getMediaEditState().phase, "launching");
  api.updateMediaEditState({ phase: "idle", assetIds: [] });
});

test("edited previews use Tauri conversion unchanged for Windows, UNC and macOS paths", () => {
  for (const path of [
    "C:\\Photos\\edited #1.jpg",
    "\\\\nas\\photos\\été.jpg",
    "/Users/me/Photos/été #1.jpg",
  ]) {
    assert.equal(api.editPreviewSrc(path), `asset://safe/${encodeURIComponent(path)}`);
    assert.equal(calls.at(-1).path, path);
  }
  assert.equal(api.editPreviewSrc(null), null);
});

test("optimistic imports survive failures and retain their exact completed upload lookup", async () => {
  let notifications = 0;
  const unsubscribe = api.subscribeMediaEditState(() => notifications++);
  api.updateEditImport("original", { previewSrc: "asset://preview", state: "importing" });
  api.requestMediaEdit(["original"]);
  assert.equal(api.getMediaEditState().phase, "idle", "cannot relaunch an importing asset");
  api.updateEditImport("original", {
    previewSrc: "asset://preview",
    state: "failed",
    error: "server rejected",
    uploadJobId: "edit-upload",
  });
  await api.getMediaUploads();
  assert.deepEqual(calls.at(-1), {
    command: "get_media_uploads",
    args: { editJobIds: ["edit-upload"] },
  });
  assert.equal(api.getMediaEditState().imports.original.previewSrc, "asset://preview");
  api.updateEditImport("original", {
    previewSrc: "asset://preview",
    state: "loading",
    versionId: "stacked",
  });
  assert.equal(api.getMediaEditState().imports.original.previewSrc, "asset://preview");
  api.updateEditImport("original", null);
  assert.equal(api.getMediaEditState().imports.original, undefined);
  unsubscribe();
  assert.equal(notifications, 4);
});

test("final scans explicitly prepare previews while routine scans do not", async () => {
  await api.getChangedEditorJobs();
  assert.deepEqual(calls.at(-1).args, { preparePreviews: false });
  await api.getChangedEditorJobs(true);
  assert.deepEqual(calls.at(-1).args, { preparePreviews: true });
  await api.exportMediaEdits(["original"]);
  assert.deepEqual(calls.at(-1), {
    command: "export_media_edits",
    args: { assetIds: ["original"] },
  });
});

test("partial exports preserve queued job identities alongside the later batch error", async () => {
  const invoke = globalThis.__editInvoke;
  const partial = {
    uploads: [{ id: "queued-edit", originalAssetId: "original" }],
    error: "second export failed",
  };
  globalThis.__editInvoke = async () => partial;
  assert.deepEqual(await api.exportMediaEdits(["original", "second"]), partial);
  globalThis.__editInvoke = invoke;
});

test("workflow keeps the edit busy through launch/focus/detection and awaits the final scan", async () => {
  const effects = [];
  const stateWrites = [];
  globalThis.__editHooks = {
    useRef: (current) => ({ current }),
    useState: (initial) => [initial, (value) => stateWrites.push(value)],
    useCallback: (fn) => fn,
    useEffect: (fn) => effects.push(fn),
  };
  globalThis.__editApi = {
    ...api,
    trackFeature: () => {},
    trackMediaEvent: async () => {},
  };
  const workflowSource = readFileSync(
    new URL("../src/components/Media/MediaWorkflow.tsx", import.meta.url),
    "utf8",
  );
  let { outputText: workflow } = ts.transpileModule(workflowSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  workflow = workflow
    .replace(/import \{[^}]+\} from "react\/jsx-runtime";/, "")
    .replace(/import \{([^}]+)\} from "react";/, "const {$1} = globalThis.__editHooks;")
    .replace(
      /import \{ useQueryClient \} from "@tanstack\/react-query";/,
      "const useQueryClient = () => ({invalidateQueries: async () => {}});",
    )
    .replace(/import \{([^}]+)\} from "..\/..\/api\/media";/, "const {$1} = globalThis.__editApi;")
    .replace(
      /import \{ useConnectionContext \}[^;]+;/,
      "const useConnectionContext = () => ({isOnline: false});",
    )
    .replace(
      /import \{ useMediaLabels \}[^;]+;/,
      "const useMediaLabels = () => ({editFailed: 'launch failed'});",
    )
    .replace(/import \{ useSessionReplay \}[^;]+;/, "const useSessionReplay = () => {};")
    .replace(/import \{ ImportDialog \}[^;]+;/, "const ImportDialog = () => null;");
  workflow =
    "const _jsx = (type, props) => ({type, props}), _jsxs = _jsx, _Fragment = 'fragment';\n" +
    workflow;
  const { MediaWorkflow } = await import(
    `data:text/javascript;base64,${Buffer.from(workflow).toString("base64")}`
  );
  let resolveLaunch;
  let rejectLaunch;
  let resolveScan;
  let rejectScan;
  let explicitScan = false;
  globalThis.__editInvoke = async (command) => {
    if (command === "begin_media_edit")
      return new Promise((resolve, reject) => {
        resolveLaunch = resolve;
        rejectLaunch = reject;
      });
    if (command === "get_changed_editor_jobs" && explicitScan)
      return new Promise((resolve, reject) => {
        resolveScan = resolve;
        rejectScan = reject;
      });
    return [];
  };
  api.updateMediaEditState({ phase: "idle", assetIds: [], imports: {} });
  MediaWorkflow({ enabled: true, page: "photos" });
  const cleanup = effects.map((effect) => effect()).filter((fn) => typeof fn === "function");
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  api.requestMediaEdit(["original"]);
  assert.equal(api.getMediaEditState().phase, "launching");
  resolveLaunch();
  await settle();
  assert.equal(api.getMediaEditState().phase, "editing");
  window.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(api.getMediaEditState().phase, "editing");
  explicitScan = true;
  api.requestFinishMediaEdit();
  assert.equal(api.getMediaEditState().phase, "finishing");
  rejectScan(new Error("scan unavailable"));
  await settle();
  assert.equal(api.getMediaEditState().phase, "editing");
  api.requestFinishMediaEdit();
  resolveScan([{ assetId: "original", localPath: "photo.CR3", previewPath: "edited.jpg" }]);
  await settle();
  assert.equal(api.getMediaEditState().phase, "idle");
  assert.ok(
    stateWrites.some((value) => Array.isArray(value) && value[0]?.previewPath === "edited.jpg"),
  );
  api.requestMediaEdit(["original"]);
  rejectLaunch(new Error("missing editor"));
  await settle();
  assert.equal(api.getMediaEditState().phase, "idle");
  assert.ok(
    stateWrites.some((value) => typeof value === "string" && value.includes("missing editor")),
  );
  cleanup.forEach((fn) => fn());
});

test("fullscreen retains its optimistic preview until the exact version image has loaded", async () => {
  const effects = [];
  let requestedId;
  let resolveThumbnail;
  let resolveImage;
  globalThis.__overlayReact = {
    useRef: (current) => ({ current }),
    useState: (initial) => [initial, () => {}],
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useEffect: (fn) => effects.push(fn),
    useLayoutEffect: () => {},
  };
  globalThis.__overlayDeps = {
    ...api,
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: "fragment",
    useI18n: () => ({ t: (key) => key }),
    useSearchTimeI18n: () => (key) => key,
    useMediaLabels: () => ({ editPreview: "Edited image preview" }),
    isMacPlatform: () => false,
    isVideoAsset: () => false,
    useAssetState: () => ({}),
    getAssetThumbnail: (id) => {
      requestedId = id;
      return new Promise((resolve) => {
        resolveThumbnail = resolve;
      });
    },
    preloadImage: () =>
      new Promise((resolve) => {
        resolveImage = resolve;
      }),
  };
  const source = readFileSync(
    new URL("../src/components/PhotoGrid/PhotoGridFullscreenOverlay.tsx", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const module = outputText
    .replace(/import React from "react";/, "const React = globalThis.__overlayReact;")
    .replace(
      /import \{([^}]+)\} from "[^"]+";/g,
      (_match, names) => `const {${names.replace(/\bas\b/g, ":")}} = globalThis.__overlayDeps;`,
    );
  const { PhotoGridFullscreenOverlay } = await import(
    `data:text/javascript;base64,${Buffer.from(module).toString("base64")}`
  );
  api.updateEditImport("original", {
    previewSrc: "asset://edited-preview",
    state: "loading",
    versionId: "stacked",
  });
  const tree = PhotoGridFullscreenOverlay({
    activeAsset: {
      id: "stacked",
      stackOriginalId: "original",
      originalFileName: "edited.jpg",
      type: "IMAGE",
    },
    activeIndex: 0,
    displayAssets: [],
    activeStillSrc: "stale-original-image",
    activeSrc: "stale-original-image",
    activeFullsizeStillSrc: null,
    zoom: 100,
  });
  const containsPreview = (node) =>
    node &&
    typeof node === "object" &&
    (node.props?.src === "asset://edited-preview" ||
      Object.values(node).some((value) =>
        Array.isArray(value) ? value.some(containsPreview) : containsPreview(value),
      ));
  assert.ok(containsPreview(tree));
  const cleanup = effects.map((effect) => effect()).filter((fn) => typeof fn === "function");
  assert.equal(requestedId, "stacked", "stale parent image props must not complete the import");
  assert.ok(api.getMediaEditState().imports.original);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  resolveThumbnail("actual-stacked-image");
  await settle();
  assert.ok(
    api.getMediaEditState().imports.original,
    "fetching the URL is not image load completion",
  );
  resolveImage();
  await settle();
  assert.equal(api.getMediaEditState().imports.original, undefined);
  cleanup.forEach((fn) => fn());
});
