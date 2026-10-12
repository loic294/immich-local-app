import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const calls = [];
globalThis.window = new EventTarget();
const timers = new Map();
window.setInterval = (callback, delay) => {
  const id = timers.size + 1;
  timers.set(id, { callback, delay });
  return id;
};
window.clearInterval = (id) => timers.delete(id);
window.setTimeout = setTimeout;
window.clearTimeout = clearTimeout;
globalThis.CustomEvent = class extends Event {
  constructor(type, { detail } = {}) {
    super(type);
    this.detail = detail;
  }
};
globalThis.__editInvoke = async (command, args) => {
  if (command === "begin_media_edit") return ["original"];
  calls.push({ command, args });
  return [];
};
globalThis.__editConvert = (path) => `asset://safe/${encodeURIComponent(path)}`;
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const load = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const api = await load(
  transpile(readFileSync(new URL("../src/api/media.ts", import.meta.url), "utf8")).replace(
    /import \{ convertFileSrc, invoke \} from "@tauri-apps\/api\/core";/,
    "const invoke = (...args) => globalThis.__editInvoke(...args); const convertFileSrc = globalThis.__editConvert;",
  ),
);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("editing reuses originals or the default album-aware full-resolution download flow", () => {
  const source = readFileSync(
    new URL("../src-tauri/src/commands/media.rs", import.meta.url),
    "utf8",
  );
  const begin = source.slice(
    source.indexOf("pub async fn begin_media_edit("),
    source.indexOf("pub async fn get_changed_editor_jobs("),
  );
  assert.match(begin, /list_local_original_paths_for_asset/);
  assert.match(begin, /Some\(path\) => PathBuf::from\(path\)/);
  assert.match(begin, /super::shell::copy_assets_to_local_folder\([\s\S]*?false,\s*Some\(true\)/);
  assert.match(begin, /result\.copied_original_count != 1/);
  assert.match(begin, /sidecar_snapshot\(&path/);
  assert.doesNotMatch(
    begin,
    /\.join\("Editing"\)|download_asset_original_to_path|"editor_original"/,
  );
});

test("missing editor sources are retired before scan/export and removed from pending UI", () => {
  const source = readFileSync(
    new URL("../src-tauri/src/commands/media.rs", import.meta.url),
    "utf8",
  );
  assert.match(source, /ErrorKind::NotFound[\s\S]*?delete_editor_job/);
  assert.match(source, /for job in db\.editor_jobs\(\)\? \{\s*if !editor_source_present/);
  assert.match(source, /if !editor_source_present\(&state\.db, job\)\? \{\s*continue;/);
  const workflow = readFileSync(
    new URL("../src/components/Media/MediaWorkflow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /setChanges\(\(current\) =>[\s\S]*?pending\.some/);
});

test("editor watchers are cleared at startup and exit, never at external editor exit", () => {
  const main = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
  assert.match(main, /\.setup\(\|app\| \{[\s\S]*?clear_editor_jobs\(\)/);
  assert.match(main, /RunEvent::Exit[\s\S]*?clear_editor_jobs\(\)/);
  const media = readFileSync(
    new URL("../src-tauri/src/commands/media.rs", import.meta.url),
    "utf8",
  );
  const childWait = media.slice(
    media.indexOf("std::thread::spawn(move ||"),
    media.indexOf("pub async fn get_changed_editor_jobs"),
  );
  assert.doesNotMatch(childWait, /clear_editor_jobs/);
});

test("timestamp and size changes update baseline without metadata notices or descriptions", () => {
  const sync = readFileSync(new URL("../src-tauri/src/commands/sync.rs", import.meta.url), "utf8");
  const scan = sync.slice(
    sync.indexOf("pub async fn scan_saved_local_files"),
    sync.indexOf("pub async fn get_saved_local_file_changes"),
  );
  assert.match(scan, /update_local_saved_asset_snapshot/);
  assert.match(scan, /"File deleted locally"/);
  assert.doesNotMatch(
    scan,
    /"File metadata changed locally"|update_asset_description|pending_mutations/,
  );
  assert.match(sync, /WHERE change_kind = 'modified' AND resolved_at IS NULL/);
});

test("Edit remains busy through launch, focus and process exit; duplicate launches are blocked", () => {
  let launches = 0;
  const listener = () => launches++;
  window.addEventListener("media:edit-request", listener);
  api.requestMediaEdit(["original"]);
  api.requestMediaEdit(["another"]);
  assert.equal(launches, 1);
  api.updateMediaEditState({ phase: "editing" });
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("media:editor-exited"));
  assert.equal(api.getMediaEditState().phase, "editing");
  assert.equal(api.requestFinishMediaEdit, undefined);
  api.updateMediaEditState({ phase: "idle", assetIds: [] });
  window.removeEventListener("media:edit-request", listener);
});

test("preview conversion supports Windows, UNC and macOS paths unchanged", () => {
  for (const path of ["C:\\Photos\\edited #1.jpg", "\\\\nas\\photos\\été.jpg", "/Users/me/été.jpg"])
    assert.equal(api.editPreviewSrc(path), `asset://safe/${encodeURIComponent(path)}`);
  assert.equal(api.editPreviewSrc(null), null);
});

test("image preload resolves on load and rejects errors or a stalled load", async () => {
  const utils = await load(
    transpile(
      readFileSync(
        new URL("../src/components/PhotoGrid/photoGridUtils.ts", import.meta.url),
        "utf8",
      ),
    )
      .replace(
        /import \{ convertFileSrc \} from "@tauri-apps\/api\/core";/,
        "const convertFileSrc = globalThis.__editConvert;",
      )
      .replace(
        /import \{ thumbHashToRGBA \} from "thumbhash";/,
        "const thumbHashToRGBA = () => {};",
      ),
  );
  const previousImage = globalThis.Image;
  try {
    globalThis.Image = class {
      set src(value) {
        if (value === "loaded") queueMicrotask(() => this.onload?.());
        if (value === "broken") queueMicrotask(() => this.onerror?.());
      }
    };
    await utils.preloadImage("loaded");
    await assert.rejects(utils.preloadImage("broken"), /Failed to preload image/);
    await assert.rejects(utils.preloadImage("stalled", 1), /Image loading timed out/);
  } finally {
    globalThis.Image = previousImage;
  }
});

test("pending imports retain exact completed job lookup and can retry image-load failures", async () => {
  api.updateEditImport("original", {
    previewSrc: "asset://preview",
    state: "failed",
    error: "image unavailable",
    uploadJobId: "edit-upload",
    versionId: "version",
  });
  api.requestMediaEdit(["original"]);
  assert.equal(api.getMediaEditState().phase, "idle");
  await api.getMediaUploads();
  assert.deepEqual(calls.at(-1).args, { editJobIds: ["edit-upload"] });
  await api.retryMediaUploads();
  assert.equal(api.getMediaEditState().imports.original.state, "loading");
  assert.equal(api.getMediaEditState().imports.original.previewSrc, "asset://preview");
  api.updateEditImport("original", null);
});

async function workflowHarness(dependencies = {}) {
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
    ...dependencies,
  };
  let module = transpile(
    readFileSync(new URL("../src/components/Media/MediaWorkflow.tsx", import.meta.url), "utf8"),
  )
    .replace(/import \{[^}]+\} from "react\/jsx-runtime";/, "")
    .replace(/import \{([^}]+)\} from "react";/, "const {$1} = globalThis.__editHooks;")
    .replace(
      /import \{ useQueryClient \} from "@tanstack\/react-query";/,
      "const useQueryClient = () => ({invalidateQueries: async () => {}});",
    )
    .replace(/import \{([^}]+)\} from "..\/..\/api\/media";/, "const {$1} = globalThis.__editApi;")
    .replace(/import \{([^}]+)\} from "..\/..\/api\/tauri";/, "const {$1} = globalThis.__editApi;")
    .replace(
      /import \{([^}]+)\} from "..\/PhotoGrid\/photoGridUtils";/,
      "const {$1} = globalThis.__editApi;",
    )
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
  module =
    "const _jsx = (type, props) => ({type, props}), _jsxs = _jsx, _Fragment = 'fragment';\n" +
    module;
  // Separate module instance for each harness, even when the transpiled source is identical.
  const { MediaWorkflow } = await load(module + `\n// harness ${Math.random()}`);
  MediaWorkflow({ enabled: true, page: "photos" });
  const cleanup = effects.map((effect) => effect()).filter((value) => typeof value === "function");
  await settle();
  return { stateWrites, cleanup: () => cleanup.forEach((fn) => fn()) };
}

test("watched sidecar detection ends editing automatically and prepares the import preview", async () => {
  let changed = false;
  let scans = 0;
  globalThis.__editInvoke = async (command, args) => {
    if (command === "begin_media_edit") return ["original"];
    if (command === "get_changed_editor_jobs") {
      scans++;
      return changed
        ? [
            {
              assetId: "original",
              localPath: "photo.CR3",
              previewPath: args.preparePreviews ? "edited.jpg" : null,
            },
          ]
        : [];
    }
    return [];
  };
  api.updateMediaEditState({ phase: "idle", assetIds: [], imports: {} });
  const harness = await workflowHarness();
  api.requestMediaEdit(["edited-version"]);
  await settle();
  assert.equal(api.getMediaEditState().phase, "editing");
  assert.deepEqual(api.getMediaEditState().assetIds, ["original"]);
  window.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(api.getMediaEditState().phase, "editing", "unchanged sidecar keeps Edit busy");
  changed = true;
  window.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(api.getMediaEditState().phase, "idle");
  assert.ok(
    harness.stateWrites.some(
      (value) => Array.isArray(value) && value[0]?.previewPath === "edited.jpg",
    ),
  );
  assert.ok(scans >= 3);
  harness.cleanup();
});

test("import completes after stack and exact image load, without any fullscreen mounted", async () => {
  let resolveImage;
  const events = [];
  const listener = (event) => events.push(event.detail);
  window.addEventListener("media:open-version", listener);
  const job = {
    id: "upload",
    originalAssetId: "original",
    serverAssetId: "edited",
    accountId: "account",
    state: "complete",
  };
  globalThis.__editInvoke = async (command) => (command === "get_media_uploads" ? [job] : []);
  api.updateMediaEditState({ phase: "idle", assetIds: [], imports: {} });
  api.updateEditImport("original", {
    previewSrc: "asset://preview",
    state: "importing",
    uploadJobId: "upload",
  });
  const harness = await workflowHarness({
    getEditVersions: async () => [
      { id: "edited", stackOriginalId: "original" },
      { id: "original" },
    ],
    getAssetThumbnail: async (id, account) => {
      assert.equal(id, "edited");
      assert.equal(account, "account");
      return "actual-edited-image";
    },
    preloadImage: (source) => {
      assert.equal(source, "actual-edited-image");
      return new Promise((resolve) => {
        resolveImage = resolve;
      });
    },
  });
  assert.equal(api.getMediaEditState().imports.original.state, "loading");
  assert.equal(events.length, 0);
  resolveImage();
  await settle();
  assert.equal(api.getMediaEditState().imports.original, undefined);
  assert.equal(events[0].assetId, "edited");
  harness.cleanup();
  window.removeEventListener("media:open-version", listener);
});

test("temporary thumbnail failure keeps the pill until a later exact-image load", async () => {
  const job = {
    id: "thumbnail-pending",
    originalAssetId: "original",
    serverAssetId: "edited",
    accountId: "account",
    state: "complete",
  };
  globalThis.__editInvoke = async (command) => (command === "get_media_uploads" ? [job] : []);
  api.updateMediaEditState({ phase: "idle", assetIds: [], imports: {} });
  api.updateEditImport("original", { state: "importing", uploadJobId: job.id });
  let attempts = 0;
  const harness = await workflowHarness({
    getEditVersions: async () => [{ id: "edited", stackOriginalId: "original" }],
    getAssetThumbnail: async () => {
      if (++attempts === 1) throw new Error("thumbnail not generated yet");
      return "generated-thumbnail";
    },
    preloadImage: async () => {},
  });
  await settle();
  assert.equal(api.getMediaEditState().imports.original.state, "loading");
  window.dispatchEvent(new Event("focus"));
  await settle();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(api.getMediaEditState().imports.original, undefined);
  harness.cleanup();
});

test("an unavailable image stops waiting after the deadline and exposes queue retry", async () => {
  const job = {
    id: "thumbnail-unavailable",
    originalAssetId: "original",
    serverAssetId: "edited",
    accountId: "account",
    state: "complete",
  };
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  let harness;
  try {
    globalThis.__editInvoke = async (command) => (command === "get_media_uploads" ? [job] : []);
    api.updateMediaEditState({ phase: "idle", assetIds: [], imports: {} });
    api.updateEditImport("original", { state: "importing", uploadJobId: job.id });
    harness = await workflowHarness({
      getEditVersions: async () => [{ id: "edited", stackOriginalId: "original" }],
      getAssetThumbnail: async () => {
        throw new Error("image unavailable");
      },
    });
    await settle();
    assert.equal(api.getMediaEditState().imports.original.state, "loading");
    now = 61_000;
    window.dispatchEvent(new Event("focus"));
    await settle();
    await settle();
    assert.equal(api.getMediaEditState().imports.original.state, "failed");
    assert.ok(
      harness.stateWrites.some(
        (value) =>
          typeof value === "function" &&
          value([]).some((item) => item.id === job.id && item.state === "failed"),
      ),
    );
  } finally {
    Date.now = realNow;
    harness?.cleanup();
  }
});

test("photo and grid import pills are independent of the video-loading branch", () => {
  const overlay = readFileSync(
    new URL("../src/components/PhotoGrid/PhotoGridFullscreenOverlay.tsx", import.meta.url),
    "utf8",
  );
  const grid = readFileSync(
    new URL("../src/components/PhotoGrid/PhotoGrid.tsx", import.meta.url),
    "utf8",
  );
  assert.match(overlay, /<EditImportPill originalId=\{originalId\} \/>/);
  assert.match(grid, /<EditImportPill originalId=\{asset\.stackOriginalId \?\? asset\.id\} \/>/);
  assert.doesNotMatch(overlay, /finishEditing|requestFinishMediaEdit/);
  const pill = readFileSync(
    new URL("../src/components/Media/EditImportPill.tsx", import.meta.url),
    "utf8",
  );
  assert.match(pill, /absolute bottom-2/);
  assert.match(pill, /loading-spinner loading-xs/);
  const events = readFileSync(
    new URL("../src/components/PhotoGrid/usePhotoGridExternalEvents.ts", import.meta.url),
    "utf8",
  );
  assert.match(events, /if \(getMediaEditState\(\)\.imports\[originalId\]\)/);
});
