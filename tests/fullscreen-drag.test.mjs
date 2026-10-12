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
