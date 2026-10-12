import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("album sync sits directly after Explorer and refreshes actual local status", () => {
  const page = read("src/pages/AlbumsPage.tsx");
  const explorer = page.indexOf('{t("albums.openExplorer")}');
  const sync = page.indexOf('{t("albums.syncLocal")}');
  const remove = page.indexOf('{t("albums.deleteLocal")}');
  assert.ok(explorer < sync && sync < remove);
  assert.match(page, /onClick=\{handleSaveAlbumLocally\}/);
  assert.match(page, /localStatus\.data\.missingCount/);
  assert.match(page, /className="tooltip tooltip-bottom"/);
  assert.match(page, /data-tip=\{\s*localStatus\.data/);
  assert.match(page, /aria-describedby="album-sync-local-status"/);
  assert.match(page, /id="album-sync-local-status" className="sr-only" role="status"/);
  assert.match(page, /finally \{[\s\S]*?invalidateQueries\(\{[\s\S]*?album-local-status/);
  assert.match(page, /isSavingAlbum \|\| isDeletingLocalAlbum \|\| isOnline !== true/);
});

test("album cards distinguish partial folders from completed downloads", () => {
  const card = read("src/components/Albums/AlbumCard.tsx");
  assert.match(card, /useAlbumLocalStatus\(album\.id, album\.savedLocalFolderPath\)/);
  assert.match(card, /missingCount === 0/);
  assert.match(card, /badge-success.*badge-warning/);
  assert.match(card, /albums\.missingLocalFiles/);
});

test("local status never requires a network call and sync does not accept preview fallbacks", () => {
  const status = read("src-tauri/src/commands/album_local_status.rs");
  assert.match(status, /path\.is_file\(\)/);
  assert.match(status, /path\.parent\(\) == Some\(Path::new\(folder\)\)/);
  assert.doesNotMatch(status, /client\.|\.await/);
  const save = read("src-tauri/src/commands/albums.rs");
  assert.match(save, /copy_assets_to_local_folder_internal\([\s\S]*?\n\s*false,/);
  assert.match(save, /offline: album download/);
  assert.match(save, /Album download incomplete/);
  assert.match(save, /!existing_ids\.contains\(&asset\.id\)/);
  assert.match(save, /upsert_assets\(&account_id, &new_assets\)/);
});
