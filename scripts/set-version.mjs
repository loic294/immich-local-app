// Sets the app version across package.json, src-tauri/tauri.conf.json and
// src-tauri/Cargo.toml. Used by the release workflow so a single computed
// version is baked into every build (the updater compares this value).
//
// Usage: node scripts/set-version.mjs <version>
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`[set-version] invalid version: ${version ?? "<none>"}`);
  process.exit(1);
}

function setJsonVersion(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  json.version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`[set-version] ${path} -> ${version}`);
}

setJsonVersion("package.json");
setJsonVersion("src-tauri/tauri.conf.json");

// Cargo.toml: only the [package] version sits at the start of a line.
const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
const versionPattern = /^version = ".*"/m;
if (!versionPattern.test(cargo)) {
  console.error(
    `[set-version] no [package] version line found in ${cargoPath}`,
  );
  process.exit(1);
}
writeFileSync(
  cargoPath,
  cargo.replace(versionPattern, `version = "${version}"`),
);
console.log(`[set-version] ${cargoPath} -> ${version}`);
