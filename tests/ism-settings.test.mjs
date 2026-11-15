import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/components/Settings/OfflineDownloadsSettings.tsx", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
});
const nodeRequire = createRequire(import.meta.url);
const module = { exports: {} };
const doubles = {
  "../../api/ism": {},
  "../../i18n": { useI18n: () => ({ t: (key) => key }) },
};
const require = (name) => {
  if (name in doubles) return doubles[name];
  assert.ok(!name.startsWith("."), `unexpected local import: ${name}`);
  return nodeRequire(name);
};
new Function("require", "module", "exports", outputText)(require, module, module.exports);
const { OfflineDownloadsSettings } = module.exports;

test("settings show one connection per Immich server and disable editing until loaded", () => {
  const markup = renderToStaticMarkup(
    React.createElement(OfflineDownloadsSettings, {
      accounts: [
        { id: "one", serverUrl: "https://immich.example/" },
        { id: "two", serverUrl: "https://immich.example" },
        { id: "three", serverUrl: "https://other.example" },
      ],
    }),
  );
  assert.equal((markup.match(/settings\.ismLoading/g) ?? []).length, 2);
  assert.equal((markup.match(/type="password"/g) ?? []).length, 2);
  assert.equal((markup.match(/disabled=""/g) ?? []).length, 6);
  assert.ok(markup.includes("settings.ismTokenStorage"));
  assert.ok(markup.includes("settings.ismLimitations"));
  assert.ok(!markup.includes("settings.ismImportTitle"), "management needs a loaded provider");
  assert.equal((markup.match(/settings\.ismActivityTitle/g) ?? []).length, 1);
});

test("settings explain why no connection controls are shown without accounts", () => {
  const markup = renderToStaticMarkup(
    React.createElement(OfflineDownloadsSettings, { accounts: [] }),
  );
  assert.ok(markup.includes("settings.ismNoAccounts"));
  assert.ok(!markup.includes('type="password"'));
  assert.ok(!markup.includes("settings.ismActivityTitle"));
});

test("ISM refusals are explained and other errors keep the server detail", () => {
  const errorsSource = readFileSync(new URL("../src/utils/ismErrors.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(errorsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const errorsModule = { exports: {} };
  new Function("module", "exports", compiled)(errorsModule, errorsModule.exports);
  const { ismErrorCode, ismErrorMessage } = errorsModule.exports;
  const labels = {
    maintenance_blocked: "busy",
    direct_writes_unavailable: "no writes",
    revision_changed: "changed",
    destination_exists: "exists",
  };
  assert.equal(ismErrorMessage("ISM maintenance_blocked: watcher running", labels), "busy");
  assert.equal(
    ismErrorMessage(new Error("ISM operation failed: revision_changed: stale"), labels),
    "changed",
  );
  assert.equal(
    ismErrorMessage("ISM operation partial: destination_exists: b.jpg", labels),
    "exists",
  );
  assert.equal(ismErrorCode("ISM direct_writes_unavailable: gate"), "direct_writes_unavailable");
  assert.equal(ismErrorCode("ISM not_found: gone"), null);
  assert.equal(ismErrorMessage("ISM not_found: gone", labels), "ISM not_found: gone");
});
