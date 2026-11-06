import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/components/Filters/FilterBar.tsx", import.meta.url),
  "utf8",
);

test("the account filter is the last filter in the bar, right before Clear", () => {
  const filters = [...source.matchAll(/<(\w+Filter)\b/g)].map((match) => match[1]);

  assert.equal(filters.filter((name) => name === "AccountFilter").length, 1);
  assert.equal(filters.at(-1), "AccountFilter");
  assert.ok(
    source.indexOf("<AccountFilter") < source.indexOf('t("filters.clear")'),
    "Clear stays after the last filter",
  );
});

test("the account filter stays hidden until a second account is configured", () => {
  assert.match(source, /accounts\.length > 1 && \(\s*<AccountFilter/);
});
