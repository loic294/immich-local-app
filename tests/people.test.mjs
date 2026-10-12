import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/utils/people.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { visiblePeople } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const person = (id, name, assetCount, isHidden = false) => ({
  id,
  name,
  assetCount,
  isHidden,
  accountId: "account-a",
});
const people = [
  person("unnamed", "", 500),
  person("z", "Zoé", 2),
  person("a", "Alice", 1),
  person("spaces", "   ", 1000),
  person("hidden", "Hidden", 9999, true),
];

test("both sorts rank visible named people ahead of every unnamed person", () => {
  assert.deepEqual(
    visiblePeople(people, "", false, "name", "Unnamed").map((p) => p.id),
    ["a", "z", "spaces", "unnamed"],
  );
  assert.deepEqual(
    visiblePeople(people, "", false, "count", "Unnamed").map((p) => p.id),
    ["z", "a", "spaces", "unnamed"],
  );
  assert.equal(people[0].id, "unnamed", "sorting must not mutate cached data");
});

test("turning off show unnamed retains only named visible people", () => {
  assert.deepEqual(
    visiblePeople(people, "", true, "name", "Unnamed").map((p) => p.id),
    ["a", "z"],
  );
});

test("cached search trims input and matches names and localized unnamed labels", () => {
  assert.deepEqual(
    visiblePeople(people, " ALI ", false, "count", "Sans nom").map((p) => p.id),
    ["a"],
  );
  assert.equal(visiblePeople(people, "sans NOM", false, "name", "Sans nom").length, 2);
  assert.equal(visiblePeople(people, "hidden", false, "name", "Sans nom").length, 0);
});
