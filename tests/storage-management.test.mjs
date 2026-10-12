import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("storage lists each album and timeline with sizes and scoped deletion", () => {
  const component = read("src/components/Settings/LocalStorageGroups.tsx");
  assert.match(component, /groups\.data\?\.map/);
  assert.match(component, /group\.albumId === null/);
  assert.match(component, /formatStorageBytes\(group\.bytes\)/);
  assert.match(component, /prepare\.mutateAsync\(group\.albumId\)/);
  assert.match(component, /remove\.mutate\(confirmation\.preview/);
  assert.match(component, /confirmation\.preview\.unverifiedCount > 0/);
  assert.match(component, /<StorageConfirmationDialog/);
  const hook = read("src/hooks/useLocalStorageGroups.ts");
  for (const key of [
    "local-storage-groups",
    "storage-summary",
    "albums",
    "album-local-status",
    "assets",
  ]) {
    assert.ok(hook.includes(`"${key}"`));
  }
});

test("storage confirmations are in-app, cancellable, and keyboard-isolated", () => {
  const settings = read("src/components/Settings/StorageSettings.tsx");
  assert.match(settings, /<LocalStorageGroups/);
  assert.doesNotMatch(settings, /window\.confirm|window\.alert/);
  const dialog = read("src/components/Settings/StorageConfirmationDialog.tsx");
  assert.match(dialog, /dialog\?\.showModal\(\)/);
  assert.match(dialog, /className="modal"/);
  assert.match(dialog, /className="modal-box"/);
  assert.match(dialog, /aria-describedby/);
  assert.match(dialog, /event\.stopPropagation\(\)/);
  assert.match(dialog, /if \(!busy\) onClose\(\)/);
});

test("storage measurement is offline and removal never recursively deletes folders", () => {
  const backend = read("src-tauri/src/commands/local_storage.rs");
  const measure = backend.slice(
    backend.indexOf("fn groups("),
    backend.indexOf("fn selected_files("),
  );
  assert.doesNotMatch(measure, /client\.|\.await|ping\(/);
  assert.match(measure, /regular_size\(&copy\.path\)/);
  assert.match(backend, /verify_backup_with_connectivity/);
  assert.match(backend, /ensure_not_pending/);
  assert.match(backend, /plan\.unverified_count > 0 && !allow_unverified/);
  const production = backend.slice(0, backend.indexOf("#[cfg(test)]"));
  assert.doesNotMatch(production, /remove_dir_all/);
});
