import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

async function loadModule(path) {
  const { outputText } = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const picker = await loadModule("../src/utils/monthYearPicker.ts");

test("year pages are fixed-size and aligned to the minimum year", () => {
  assert.equal(picker.yearPageStart(1900), 1900);
  assert.equal(picker.yearPageStart(1911), 1900);
  assert.equal(picker.yearPageStart(1912), 1912);
  assert.equal(picker.yearPageStart(2026), 2020);
  assert.deepEqual(
    picker.yearsOnPage(2020),
    [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031],
  );
});

test("year paging stays inside the supported range", () => {
  assert.equal(picker.shiftYearPage(1900, -1), 1900);
  assert.equal(picker.shiftYearPage(2020, -1), 2008);
  assert.equal(picker.shiftYearPage(2020, 1), 2032);
  const lastPage = picker.yearPageStart(picker.MAX_PICKER_YEAR);
  assert.equal(picker.shiftYearPage(lastPage, 1), lastPage);
  assert.equal(picker.yearsOnPage(lastPage).at(-1), picker.MAX_PICKER_YEAR);
  assert.equal(picker.clampYear(1800), picker.MIN_PICKER_YEAR);
  assert.equal(picker.clampYear(2500), picker.MAX_PICKER_YEAR);
});

test("calendar picker opens the quick picker from the month caption and keeps month controlled", () => {
  const source = read("../src/components/Settings/DaisyCalendarPicker.tsx");
  assert.match(source, /CaptionLabel:/);
  assert.match(source, /<MonthCaptionButton onOpen=\{openQuickPicker\}>/);
  assert.match(source, /<MonthYearQuickPicker/);
  assert.match(source, /month=\{month\}/);
  assert.match(source, /onMonthChange=\{setMonth\}/);
  assert.match(source, /setMonth\(nextMonth\)/);
  assert.match(source, /onChange\(toDateOnly\(date\)\)/);
});

test("quick picker only changes the displayed month, never the selected date", () => {
  const source = read("../src/components/Settings/MonthYearQuickPicker.tsx");
  assert.match(source, /onSelect\(new Date\(year, index, 1\)\)/);
  assert.doesNotMatch(source, /onChange/);
});

test("quick picker labels exist in both languages", () => {
  const source = read("../src/i18n/monthYearPicker.ts");
  const keys = ["chooseMonthYear", "chooseYear", "previousYear", "nextYear", "backToCalendar"];
  for (const key of keys) {
    assert.equal(
      source.split(`${key}:`).length - 1,
      2,
      `${key} must be defined in en-CA and fr-CA`,
    );
  }
});
