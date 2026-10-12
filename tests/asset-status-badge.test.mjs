import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as icons from "lucide-react";

const source = readFileSync(
  new URL("../src/components/PhotoGrid/assetStatusBadge.utils.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const exports = {};
new Function("require", "exports", outputText)((name) => {
  assert.equal(name, "lucide-react");
  return icons;
}, exports);
const state = {
  isOnline: true,
  isPreviewLoading: false,
  isFullResLoading: false,
  isPreviewCached: false,
  isFullResCached: false,
  mediaType: "image",
};
const content = (changes) => exports.getStatusBadgeContent({ ...state, ...changes }, (key) => key);

test("status icons distinguish saved previews, originals, transfers, offline and unavailable", () => {
  for (const [changes, icon, color, clickable] of [
    [{ isFullResCached: true }, icons.CircleCheck, "text-success", true],
    [{ isPreviewCached: true }, icons.ImageDown, "text-info", true],
    [{ isPreviewLoading: true }, icons.CloudSync, "text-info", false],
    [{ isFullResLoading: true }, icons.CloudSync, "text-info", false],
    [{ isOnline: false, isPreviewCached: true }, icons.WifiOff, "text-warning", false],
    [{ isOnline: false }, icons.CloudOff, "text-error", false],
    [{ mediaType: "video" }, icons.CloudDownload, "text-error", true],
  ]) {
    const badge = content(changes);
    assert.equal(badge.icon, icon);
    assert.equal(badge.iconColor, color);
    assert.equal(badge.isClickable, clickable);
    assert.ok(badge.title);
    assert.ok(badge.subtitle);
  }
  assert.equal(content({}), null);
});

test("badge applies status color and provides readable padding and text spacing", () => {
  const badge = readFileSync(
    new URL("../src/components/PhotoGrid/AssetStatusBadge.tsx", import.meta.url),
    "utf8",
  );
  assert.match(badge, /gap-3 rounded-box px-3 py-2 text-left/);
  assert.match(badge, /badgeContent\.iconColor/);
  assert.match(badge, /items-start gap-1/);
  assert.match(badge, /text-xs text-white\/70 leading-relaxed/);
  assert.match(badge, /aria-hidden="true"/);
});

test("successful local download invalidates the hook's cached status instead of discarding a read", () => {
  const overlay = readFileSync(
    new URL("../src/components/PhotoGrid/PhotoGridFullscreenOverlay.tsx", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(new URL("../src/hooks/useAssetState.ts", import.meta.url), "utf8");
  const download = overlay.search(/await copyAssetsToLocalFolder\(\s*\[activeAsset\.id\]/);
  const refresh = overlay.indexOf("setCacheRefreshNonce((value) => value + 1)");
  assert.ok(download >= 0 && refresh > download);
  assert.match(overlay, /useAssetState\(\{[\s\S]*?cacheRefreshNonce,/);
  assert.match(hook, /\[activeAsset, activeStillSrc, activeFullsizeStillSrc, cacheRefreshNonce\]/);
  assert.match(hook, /isFullResCached: activeFullsizeStillSrc !== null \|\| fullResolutionLocal/);
  assert.match(overlay, /const localPath = details\?\.localSavedPath/);
  assert.match(overlay, /openFolderInFileExplorer\(folder \|\| destinationFolder\)/);
});

test("photo zoom and photo/video badge downloads opt into album routing, unlike explicit exports", () => {
  const overlay = readFileSync(
    new URL("../src/components/PhotoGrid/PhotoGridFullscreenOverlay.tsx", import.meta.url),
    "utf8",
  );
  const grid = readFileSync(new URL("../src/components/PhotoGrid/PhotoGrid.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/api/tauri.ts", import.meta.url), "utf8");
  assert.match(overlay, /copyAssetsToLocalFolder\(\s*\[activeAsset\.id\],\s*destinationFolder,\s*false,\s*true,?\s*\)/);
  assert.match(grid, /copyAssetsToLocalFolder\(\[asset\.id\], destinationFolder, false, true\)/);
  assert.match(api, /preferAlbumFolder = false/);
  assert.match(overlay, /if \(result\.copiedOriginalCount === 0\)/);
  assert.match(overlay, /setDownloadError\(String\(error\)\)/);
});
test("local-original menu removal requests confirmation only when backup cannot be verified and refreshes status", () => {
  const overlay = readFileSync(
    new URL("../src/components/PhotoGrid/PhotoGridFullscreenOverlay.tsx", import.meta.url),
    "utf8",
  );
  assert.match(overlay, /assetState\.isFullResCached && \([\s\S]*?photoGrid\.removeLocalOriginal/);
  assert.match(overlay, /const result = await removeLocalOriginal\(assetId, allowUnverified\)/);
  assert.match(
    overlay,
    /if \(result\.confirmationRequired\)[\s\S]*?setRemovalConfirmation\([\s\S]*?return;/,
  );
  assert.match(
    overlay,
    /onConfirm=\{[\s\S]*?handleRemoveLocalOriginal\(removalConfirmation.assetId, true\)/,
  );
  assert.doesNotMatch(overlay, /plugin-dialog|window\.confirm|await confirm/);
  const dialog = readFileSync(
    new URL("../src/components/PhotoGrid/LocalOriginalRemovalDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(dialog, /className="modal"/);
  assert.match(dialog, /modal-box/);
  assert.match(dialog, /modal-action/);
  assert.match(dialog, /modal-backdrop/);
  assert.match(dialog, /dialog\?\.showModal\(\)/);
  assert.match(dialog, /onKeyDown=\{[\s\S]*?stopPropagation/);
  assert.match(dialog, /onCancel=\{[\s\S]*?if \(!busy\) onClose\(\)/);
  assert.match(overlay, /onLocalOriginalRemoved\(assetId\);[\s\S]*?setCacheRefreshNonce/);
  assert.match(overlay, /<ul[\s\S]*?onPointerDown=\{[\s\S]*?event\.preventDefault\(\)/);
  assert.match(overlay, /role="alert"[\s\S]*?localRemovalError/);
  const grid = readFileSync(
    new URL("../src/components/PhotoGrid/PhotoGrid.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    grid,
    /onLocalOriginalRemoved=\{[\s\S]*?activeAssetRef\.current\?\.id !== assetId[\s\S]*?setZoom\(100\);[\s\S]*?setActiveFullsizeStillSrc\(null\)/,
  );
});
