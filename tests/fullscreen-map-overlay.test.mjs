import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = ts.createSourceFile(
  "FullscreenInfoPanel.tsx",
  readFileSync(
    new URL("../src/components/PhotoGrid/FullscreenInfoPanel.tsx", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function find(root, predicate) {
  if (predicate(root)) return root;
  let match;
  ts.forEachChild(root, (node) => {
    match ??= find(node, predicate);
  });
  return match;
}

function classes(element) {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  const attribute = opening.attributes.properties.find(
    (node) => ts.isJsxAttribute(node) && node.name.text === "className",
  );
  return attribute?.initializer?.text?.split(/\s+/) ?? [];
}

const mapAction = find(
  source,
  (node) => ts.isCallExpression(node) && node.expression.getText(source) === "openAssetOnMap",
);
const button = find(
  source,
  (node) =>
    ts.isJsxElement(node) &&
    node.openingElement.tagName.getText(source) === "button" &&
    find(node, (child) => child === mapAction),
);
const wrapper = button.parent;

test("map action overlays the map's own origin, without reserving a row above the map", () => {
  assert.ok(ts.isJsxElement(wrapper));
  const wrapperClasses = classes(wrapper);
  assert.ok(wrapperClasses.includes("relative"));
  assert.ok(wrapperClasses.includes("isolate"));
  assert.ok(!wrapperClasses.some((name) => /^(?:p|pt|py)-/.test(name)));
  const mapContent = wrapper.children.find((child) => ts.isJsxElement(child) && child !== button);
  assert.ok(mapContent);
  assert.deepEqual(classes(mapContent), []);
  for (const tag of ["MapTilerLocationMap", "iframe"]) {
    assert.ok(
      find(
        mapContent,
        (node) =>
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(source) === tag,
      ),
    );
  }
});

test("map action is an inset outline overlay above the map's stacking context", () => {
  for (const name of ["absolute", "top-2", "left-2", "z-10", "btn-outline"]) {
    assert.ok(classes(button).includes(name), `Missing overlay class: ${name}`);
  }
});

test("only the offline message reserves space so the overlay cannot cover it", () => {
  const offlineMessage = find(
    wrapper,
    (node) => ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "p",
  );
  assert.ok(classes(offlineMessage).includes("pt-12"));
});
