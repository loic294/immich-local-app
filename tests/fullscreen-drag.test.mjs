import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function nodes(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const elements = [];
  function visit(node) {
    if (ts.isJsxElement(node)) elements.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { source, elements };
}

function attribute(element, name) {
  return element.openingElement.attributes.properties.find(
    (node) => ts.isJsxAttribute(node) && node.name.text === name,
  );
}

test("main header wrappers expose drag gaps without making controls draggable", () => {
  for (const path of [
    "../src/components/Layout/Header.tsx",
    "../src/components/Layout/AppTopBar.tsx",
  ]) {
    const { source, elements } = nodes(path);
    const windowHeader = elements.find(
      (node) => node.openingElement.tagName.getText(source) === "WindowHeader",
    );
    const wrappers = elements.filter((node) => node.parent === windowHeader);
    assert.ok(wrappers.length > 0);
    assert.ok(wrappers.every((node) => attribute(node, "data-tauri-drag-region")));
    for (const node of elements) {
      if (["button", "input", "summary"].includes(node.openingElement.tagName.getText(source))) {
        assert.ok(!attribute(node, "data-tauri-drag-region"));
      }
    }
  }
});

test("download status is the first Info item with bottom padding and retains action/progress", () => {
  const panel = nodes("../src/components/PhotoGrid/FullscreenInfoPanel.tsx");
  const aside = panel.elements.find(
    (node) => node.openingElement.tagName.getText(panel.source) === "aside",
  );
  const first = aside.children.find(ts.isJsxElement);
  assert.equal(
    first.children.find(ts.isJsxExpression).expression.getText(panel.source),
    "downloadStatus",
  );
  assert.ok(attribute(first, "className").initializer.text.split(/\s+/).includes("pb-4"));

  const overlay = nodes("../src/components/PhotoGrid/PhotoGridFullscreenOverlay.tsx");
  const sourceText = overlay.source.getFullText();
  const badge = sourceText.indexOf("<AssetStatusBadge");
  assert.ok(badge > sourceText.indexOf("<FullscreenInfoPanel"));
  assert.equal(sourceText.split("<AssetStatusBadge").length - 1, 1);
  for (const prop of [
    "assetState={assetState}",
    "onDownloadClick={handleStatusBadgeDownload}",
    "downloadProgress={downloadProgress}",
    "shareProgress={shareProgress}",
  ])
    assert.ok(sourceText.slice(badge).includes(prop));
});

test("photo fullscreen exposes the unobstructed header, filename and toolbar gaps as native drag regions on both platforms", () => {
  const { source, elements } = nodes("../src/components/PhotoGrid/PhotoGridFullscreenOverlay.tsx");
  const toolbar = elements.find(
    (node) => attribute(node, "ref")?.initializer?.getText(source) === "{toolbarRef}",
  );
  assert.ok(attribute(toolbar, "data-tauri-drag-region"));
  assert.ok(attribute(toolbar.parent, "data-tauri-drag-region"));
  const filename = elements.find(
    (node) =>
      attribute(node, "title")?.initializer?.getText(source) === "{activeAsset.originalFileName}",
  );
  assert.ok(attribute(filename, "data-tauri-drag-region"));
  assert.ok(!attribute(filename, "className").initializer.text.includes("select-text"));
  assert.ok(
    elements
      .filter((node) => node.openingElement.tagName.getText(source) === "button")
      .every((node) => !attribute(node, "data-tauri-drag-region")),
  );
});

test("memory fullscreen header labels and progress bars are draggable without turning buttons into drag regions", () => {
  const { source, elements } = nodes("../src/components/Memories/MemoryFullscreenViewer.tsx");
  const header = elements.find((node) => node.openingElement.tagName.getText(source) === "header");
  assert.ok(attribute(header, "data-tauri-drag-region"));
  const headerElements = elements.filter((node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent === header) return true;
    }
    return false;
  });
  for (const node of headerElements) {
    const tag = node.openingElement.tagName.getText(source);
    if (["p", "div", "span"].includes(tag)) assert.ok(attribute(node, "data-tauri-drag-region"));
    if (tag === "button") assert.ok(!attribute(node, "data-tauri-drag-region"));
  }
});
