import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function parseSource(path) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function findNodes(root, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return matches;
}

const page = parseSource("../src/pages/SettingsPage.tsx");
const isTranslation = (key) => (node) =>
  ts.isCallExpression(node) &&
  node.expression.getText(page) === "t" &&
  ts.isStringLiteral(node.arguments[0]) &&
  node.arguments[0].text === key;

const sectionCards = findNodes(
  page,
  (node) =>
    ts.isJsxElement(node) &&
    node.openingElement.attributes.properties.some(
      (attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === "hidden",
    ),
);

function sectionFor(card) {
  const hidden = card.openingElement.attributes.properties.find(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === "hidden",
  ).initializer.expression;
  assert.ok(ts.isBinaryExpression(hidden));
  assert.equal(hidden.left.getText(page), "section");
  assert.equal(hidden.operatorToken.kind, ts.SyntaxKind.ExclamationEqualsEqualsToken);
  return hidden.right.text;
}

test("Settings navigation exposes My Photos using the existing localized section label", () => {
  const sections = findNodes(
    page,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(page) === "sections",
  )[0].initializer.elements;
  assert.equal(
    sections.filter(
      (entry) =>
        entry.elements[0].text === "my-photos" &&
        entry.elements[1].text === "settings.sectionMyPhotos",
    ).length,
    1,
  );
});

test("only the existing date/camera rules editor belongs to My Photos, not General", () => {
  const myPhotosCards = sectionCards.filter((card) => sectionFor(card) === "my-photos");
  assert.equal(myPhotosCards.length, 1);
  for (const key of [
    "settings.sectionMyPhotos",
    "settings.myPhotosStartDate",
    "settings.myPhotosEndDate",
    "settings.myPhotosCamera",
    "settings.myPhotosSaveRules",
  ]) {
    const cards = sectionCards.filter((card) => findNodes(card, isTranslation(key)).length > 0);
    assert.deepEqual(cards, myPhotosCards);
  }
  for (const key of ["settings.languageTitle", "settings.sectionLivePhotos"]) {
    const card = sectionCards.find((candidate) => findNodes(candidate, isTranslation(key)).length);
    assert.equal(sectionFor(card), "general");
  }
});

test("the section label retains both English and French translations", () => {
  const translations = parseSource("../src/i18n/index.tsx");
  const labels = findNodes(
    translations,
    (node) =>
      ts.isPropertyAssignment(node) && node.name.getText(translations) === "sectionMyPhotos",
  ).map((node) => node.initializer.text);
  assert.deepEqual(labels, ["My Photos", "Mes photos"]);
});
