import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as thumbhash from "thumbhash";

const require = createRequire(import.meta.url);
const GRID = "../src/components/PhotoGrid/";

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/** Transpiles a TS/TSX module to CommonJS and runs it, resolving `mocks` before real modules. */
function load(path, mocks = {}) {
  const { outputText } = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const exports = {};
  new Function("require", "exports", outputText)(
    (name) => (Object.hasOwn(mocks, name) ? mocks[name] : require(name)),
    exports,
  );
  return exports;
}

/** Minimal hook runtime: state and refs persist across renders, effects run after each render. */
function createHookRuntime() {
  const slots = [];
  let cursor = 0;
  let version = 0;
  let effects = [];

  const react = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in slots)) {
        slots[slot] = typeof initial === "function" ? initial() : initial;
      }
      const setState = (update) => {
        const next = typeof update === "function" ? update(slots[slot]) : update;
        if (!Object.is(next, slots[slot])) {
          slots[slot] = next;
          version += 1;
        }
      };
      return [slots[slot], setState];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!(slot in slots)) {
        slots[slot] = { current: initial };
      }
      return slots[slot];
    },
    useMemo: (compute) => compute(),
    useEffect: (effect) => effects.push(effect),
  };

  /** Renders until the effects stop changing state, like React re-rendering after a state update. */
  const render = (hook, props) => {
    for (let pass = 0; pass < 5; pass += 1) {
      cursor = 0;
      effects = [];
      const versionBefore = version;
      const result = hook(props);
      effects.forEach((effect) => effect());
      if (version === versionBefore) {
        return result;
      }
    }
    throw new Error("hook did not settle");
  };

  return { react, render };
}

const utils = load(`${GRID}photoGridSelectionUtils.ts`);
const i18n = { useI18n: () => ({ t: (key, params) => `${key}(${params.day})` }) };

const item = (id) => ({ id, width: 280, thumbhash: null });
const assets = (...ids) => ids.map((id) => ({ id }));

/** A day separator and its photos, two per row. */
function section(key, ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 2) {
    rows.push({ height: 210, items: ids.slice(index, index + 2).map(item) });
  }
  return { key, label: key, rows };
}

const sections = [
  section("2024-06-05", ["a1", "a2", "a3", "a4", "a5"]),
  section("2024-06-04", ["b1", "b2"]),
  section("2024-06-03", ["c1"]),
];

function mountSelection(initialProps) {
  const runtime = createHookRuntime();
  const { usePhotoGridSelection } = load(`${GRID}usePhotoGridSelection.ts`, {
    react: runtime.react,
    "./photoGridSelectionUtils": utils,
  });
  let props = initialProps;
  return (patch) => {
    props = { ...props, ...patch };
    return runtime.render(usePhotoGridSelection, props);
  };
}

const click = { shiftKey: false, metaKey: false, ctrlKey: false };

test("a day lists every laid-out photo in grid order, loaded or not", () => {
  assert.deepEqual(utils.getSectionAssetIds(sections[0]), ["a1", "a2", "a3", "a4", "a5"]);
  assert.deepEqual(utils.getSectionAssetIds(section("empty", [])), []);
});

test("day selection state is none, some or all, and ignores other days", () => {
  const state = (selected, day = sections[0]) =>
    utils.getSectionSelectionState(day, new Set(selected));

  assert.equal(state([]), "none");
  assert.equal(state(["b1", "b2"]), "none", "photos of other days do not count");
  assert.equal(state(["a2"]), "some");
  assert.equal(state(["a1", "a2", "a3", "a4"]), "some");
  assert.equal(state(["a1", "a2", "a3", "a4", "a5"]), "all");
  assert.equal(state(["a1", "a2", "a3", "a4", "a5", "b1"]), "all");
  assert.equal(state(["a1"], section("empty", [])), "none", "an empty day is never selected");
});

test("selected photos survive while loaded or still laid out, and are dropped otherwise", () => {
  const isLoaded = (id) => id === "a1" || id === "a2";

  const loadedOnly = new Set(["a1", "a2"]);
  assert.equal(
    utils.retainKnownAssetIds(loadedOnly, isLoaded, []),
    loadedOnly,
    "loaded photos never need the layout",
  );

  const withUnloaded = new Set(["a1", "a4", "b2"]);
  assert.equal(
    utils.retainKnownAssetIds(withUnloaded, isLoaded, sections),
    withUnloaded,
    "unloaded photos that are still laid out are kept without a new Set",
  );

  const stale = new Set(["a1", "a4", "gone"]);
  const pruned = utils.retainKnownAssetIds(stale, isLoaded, sections);
  assert.deepEqual([...pruned], ["a1", "a4"]);
  assert.deepEqual([...stale], ["a1", "a4", "gone"], "the input is not mutated");

  assert.deepEqual([...utils.retainKnownAssetIds(new Set(["a4"]), isLoaded, [])], []);
});

test("the layout scan stops once every unloaded selected photo was found", () => {
  const unreachable = {
    key: "unreachable",
    label: "unreachable",
    get rows() {
      throw new Error("scanned past the last day that was needed");
    },
  };
  const selected = new Set(["a1", "b2"]);

  assert.equal(
    utils.retainKnownAssetIds(selected, () => false, [...sections.slice(0, 2), unreachable]),
    selected,
  );
});

test("toggling a day selects every photo under it, including photos that are not loaded yet", (t) => {
  t.mock.method(console, "log", () => {});
  const counts = [];
  const render = mountSelection({
    displayAssets: assets("a1", "a2"),
    layoutSections: sections,
    onSelectedCountChange: (count) => counts.push(count),
  });

  let selection = render();
  assert.equal(selection.getSectionSelectionState(0), "none");

  selection.toggleSectionSelection(0);
  selection = render();

  assert.deepEqual([...selection.selectedAssetIds].sort(), ["a1", "a2", "a3", "a4", "a5"]);
  assert.equal(selection.getSectionSelectionState(0), "all");
  assert.equal(selection.getSectionSelectionState(1), "none");
  assert.equal(counts.at(-1), 5, "the top bar counts the whole day");

  selection.toggleSectionSelection(0);
  selection = render();
  assert.equal(selection.selectedAssetIds.size, 0, "the day toggle can also end selection mode");
  assert.equal(counts.at(-1), 0);
});

test("a partly selected day is completed first, then cleared by the next toggle", (t) => {
  t.mock.method(console, "log", () => {});
  const render = mountSelection({
    displayAssets: assets("a1", "a2", "b1"),
    layoutSections: sections,
  });

  let selection = render();
  selection.applySelection("b1", 2, click);
  selection.applySelection("a2", 1, click);
  selection = render();
  assert.equal(selection.getSectionSelectionState(0), "some");

  selection.toggleSectionSelection(0);
  selection = render();
  assert.equal(selection.getSectionSelectionState(0), "all");

  selection.toggleSectionSelection(0);
  selection = render();
  assert.equal(selection.getSectionSelectionState(0), "none");
  assert.deepEqual([...selection.selectedAssetIds], ["b1"], "other days keep their selection");
  assert.equal(selection.getSectionSelectionState(1), "some");
});

test("toggling an unknown day changes nothing and warns", (t) => {
  t.mock.method(console, "log", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  const render = mountSelection({ displayAssets: assets("a1"), layoutSections: sections });

  let selection = render();
  selection.toggleSectionSelection(99);
  selection = render();

  assert.equal(selection.selectedAssetIds.size, 0);
  assert.equal(selection.getSectionSelectionState(99), "none");
  assert.equal(warn.mock.callCount(), 1);
});

test("a day selection survives more pages loading, and drops photos that left the layout", (t) => {
  t.mock.method(console, "log", () => {});
  const render = mountSelection({ displayAssets: assets("a1"), layoutSections: sections });

  let selection = render();
  selection.toggleSectionSelection(0);
  selection = render();
  assert.equal(selection.selectedAssetIds.size, 5);

  selection = render({ displayAssets: assets("a1", "a2", "a3", "a4", "a5") });
  assert.equal(selection.selectedAssetIds.size, 5, "loading the rest of the day keeps it selected");

  selection = render({ displayAssets: assets("b1"), layoutSections: sections.slice(1) });
  assert.equal(selection.selectedAssetIds.size, 0, "a filter that hides the day clears it");
});

test("the day checkbox is checked when all, indeterminate when some, and clear when none", () => {
  const expectations = {
    none: { checked: false, indeterminate: false, label: "photoGrid.selectDayAria(Today)" },
    some: { checked: false, indeterminate: true, label: "photoGrid.selectDayAria(Today)" },
    all: { checked: true, indeterminate: false, label: "photoGrid.deselectDayAria(Today)" },
  };

  for (const [state, expected] of Object.entries(expectations)) {
    const input = { indeterminate: !expected.indeterminate };
    const effects = [];
    const { DaySelectionCheckbox } = load(`${GRID}DaySelectionCheckbox.tsx`, {
      react: { useRef: () => ({ current: input }), useEffect: (effect) => effects.push(effect) },
      "../../i18n": i18n,
    });
    const onToggle = () => {};

    const { props } = DaySelectionCheckbox({ label: "Today", state, onToggle });
    effects.forEach((effect) => effect());

    assert.equal(props.type, "checkbox", state);
    assert.equal(props.checked, expected.checked, state);
    assert.equal(props["aria-label"], expected.label, state);
    assert.equal(props.onChange, onToggle, state);
    assert.equal(input.indeterminate, expected.indeterminate, state);
  }
});

test("the day checkbox renders as a small daisyUI checkbox that names its day", () => {
  const { DaySelectionCheckbox } = load(`${GRID}DaySelectionCheckbox.tsx`, { "../../i18n": i18n });
  const render = (state) =>
    renderToStaticMarkup(
      React.createElement(DaySelectionCheckbox, {
        label: "Today",
        state,
        onToggle() {},
      }),
    );

  const checked = render("all");
  assert.match(checked, /^<input /);
  assert.match(checked, /type="checkbox"/);
  assert.match(checked, /class="checkbox checkbox-sm checkbox-primary"/);
  assert.match(checked, /checked=""/);
  assert.match(checked, /aria-label="photoGrid\.deselectDayAria\(Today\)"/);
  assert.doesNotMatch(render("none"), /checked/);
  assert.doesNotMatch(render("some"), /checked/);
});

test("the day checkbox stays visible and interactive in every selection state", () => {
  const { DaySelectionCheckbox } = load(`${GRID}DaySelectionCheckbox.tsx`, {
    react: { useRef: () => ({ current: null }), useEffect: () => {} },
    "../../i18n": i18n,
  });
  let toggles = 0;

  for (const state of ["none", "some", "all"]) {
    const { props } = DaySelectionCheckbox({
      label: "Today",
      state,
      onToggle: () => toggles++,
    });

    assert.equal(props.className, "checkbox checkbox-sm checkbox-primary", state);
    assert.notEqual(props.hidden, true, state);
    assert.notEqual(props.tabIndex, -1, state);
    assert.notEqual(props.disabled, true, state);
    props.onChange();
  }

  assert.equal(toggles, 3, "the checkbox can toggle the day in every selection state");
});

test("a selected placeholder looks selected before its page has loaded", () => {
  const { AssetPlaceholder } = load(`${GRID}AssetPlaceholder.tsx`, {
    "./photoGridUtils": {
      thumbhashToDataUrl: (value) => (value ? `data:image/png;base64,${value}` : null),
    },
  });
  const render = (props) =>
    renderToStaticMarkup(
      React.createElement(AssetPlaceholder, {
        width: 280,
        thumbhash: "abc",
        isSelected: false,
        ...props,
      }),
    );

  const idle = render({});
  assert.match(idle, /width:280px/);
  assert.match(idle, /<img[^>]*src="data:image\/png;base64,abc"/);
  assert.doesNotMatch(idle, /border-primary/);
  assert.doesNotMatch(idle, /<svg/);

  const selected = render({ isSelected: true });
  assert.match(selected, /width:280px/);
  assert.match(selected, /border-4 border-primary/);
  assert.match(selected, /<svg/);
  assert.match(render({ isSelected: true, thumbhash: null }), /border-4 border-primary/);
});

test("day separators carry their index in the layout, even when a day key repeats", () => {
  const photoGridUtils = load(`${GRID}photoGridUtils.ts`, {
    "@tauri-apps/api/core": {},
    thumbhash,
  });
  const { usePhotoGridVirtualLayout } = load(`${GRID}usePhotoGridVirtualLayout.ts`, {
    react: { useMemo: (compute) => compute() },
    "./photoGridUtils": photoGridUtils,
  });
  // Sorting by filename groups contiguous runs, so the same day can head several sections.
  const repeated = [sections[0], section("2024-06-05", ["z1"]), sections[1]];

  const { virtualEntries } = usePhotoGridVirtualLayout({
    fullGridSections: repeated,
    gridSections: [],
    displayAssetIds: [],
    isUsingFullLayout: true,
    viewportHeight: 600,
    scrollTop: 0,
  });

  const headers = virtualEntries.filter((entry) => entry.type === "header");
  assert.deepEqual(
    headers.map((header) => header.sectionIndex),
    [0, 1, 2],
  );
  assert.deepEqual(
    headers.map((header) => header.sectionKey),
    ["2024-06-05", "2024-06-05", "2024-06-04"],
  );
});

test("the grid always mounts the day checkbox beside the day label", () => {
  const source = read(`${GRID}PhotoGrid.tsx`);

  assert.match(
    source,
    /<div className="flex items-center gap-2">\s*<DaySelectionCheckbox[\s\S]*?\/>\s*<span>\{entry\.label\}<\/span>\s*<\/div>/,
    "the checkbox is always mounted immediately before the day label",
  );
  assert.doesNotMatch(source, /selectedAssetIds\.size > 0 \? \(\s*<DaySelectionCheckbox/);
  assert.match(source, /getSectionSelectionState\(entry\.sectionIndex\)/);
  assert.match(source, /toggleSectionSelection\(entry\.sectionIndex\)/);
  assert.match(source, /usePhotoGridSelection\(\{[^}]*\blayoutSections\b/);
});

test("the day checkbox labels exist in English and French and name the day", () => {
  const source = read("../src/i18n/index.tsx");

  for (const key of ["selectDayAria", "deselectDayAria"]) {
    const labels = [...source.matchAll(new RegExp(`\\b${key}: "([^"]+)"`, "g"))].map(
      (match) => match[1],
    );
    assert.equal(labels.length, 2, `${key} is defined for both locales`);
    assert.notEqual(labels[0], labels[1], `${key} is translated`);
    for (const label of labels) {
      assert.match(label, /\{day\}/, `${key} names the day`);
    }
  }
});
