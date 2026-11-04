import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Phone Photos default info card text matches the requested copy", () => {
  const i18n = read("../src/i18n/phonePhotos.ts");
  assert.match(i18n, /defaultInfoTitle: "Missing photos\? How to sync them"/);
  assert.match(
    i18n,
    /defaultInfoDescription:\s*"On your phone, open Synology Photos \(the orange flower\)\. Leave the app opened and the photos should appear here soon\."/,
  );
});

test("Phone Photos is wired into the menu, settings, app and backend", () => {
  const sidebar = read("../src/components/Layout/Sidebar.tsx");
  assert.match(sidebar, /key: "phonePhotos"[\s\S]*?labelKey: "nav\.phonePhotos"/);

  const settingsPage = read("../src/pages/SettingsPage.tsx");
  assert.match(settingsPage, /\["phone-photos", "settings\.sectionPhonePhotos"\]/);
  assert.match(settingsPage, /section === "phone-photos"[\s\S]*?<PhonePhotosSettings/);

  const app = read("../src/App.tsx");
  assert.match(app, /case "phonePhotos":\s*return <PhonePhotosPage/);

  const settingsComponent = read("../src/components/Settings/PhonePhotosSettings.tsx");
  for (const field of [
    "phonePhotosFolderPath",
    "phonePhotosInfoVisible",
    "phonePhotosInfoTitle",
    "phonePhotosInfoDescription",
  ]) {
    assert.ok(settingsComponent.includes(field), `settings component edits ${field}`);
  }

  const main = read("../src-tauri/src/main.rs");
  assert.match(main, /refresh_folder_assets,\n\s+get_folders_base_directory/);
});

test("Phone Photos page only shows the info card when enabled and refreshes lazily", () => {
  const page = read("../src/pages/PhonePhotosPage.tsx");
  assert.match(page, /showInfoCard && <PhonePhotosInfoCard/);
  assert.match(page, /phonePhotosInfoVisible === true/);
  assert.match(page, /useFolderRefresh\(folderPath\)/);

  const hook = read("../src/hooks/useFolderRefresh.ts");
  assert.ok(!/setInterval/.test(hook), "folder refresh must not poll");
});

test("Phone Photos includes every subfolder while Folders stays direct-only", () => {
  const page = read("../src/pages/PhonePhotosPage.tsx");
  assert.match(page, /kind: "folder", path: folderPath, recursive: true/);
  assert.match(page, /useFolderAssets\([^)]*sortPreference, true\)/);
  assert.match(page, /getCachedFolderFullGridLayout\([\s\S]*?sortPreference,\s*true,?\s*\)/);

  const folders = read("../src/pages/FoldersPage.tsx");
  assert.ok(!/recursive/.test(folders), "Folders page keeps direct-children behavior");

  const api = read("../src/api/tauri.ts");
  assert.match(api, /"get_folder_assets_paged"[\s\S]*?recursive: recursive \?\? null/);
  assert.match(api, /"get_cached_folder_full_grid_layout"[\s\S]*?recursive: recursive \?\? null/);

  const backend = read("../src-tauri/src/commands/folders.rs");
  assert.match(backend, /get_unique_original_paths\(\)/);
  assert.match(backend, /folder_tree_targets\(&path, &server_folders\)/);
});
