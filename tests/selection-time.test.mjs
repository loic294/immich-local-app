import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(path, modules, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const exports = {};
  runInNewContext(outputText, {
    exports,
    require: (name) => modules[name] ?? {},
    console,
    ...globals,
  });
  return exports;
}

function renderActions(variant) {
  const requests = [];
  const calls = [];
  const time = load(
    "../src/api/time.ts",
    {},
    {
      window: { dispatchEvent: (event) => requests.push(event) },
      CustomEvent: class {
        constructor(type, { detail }) {
          this.type = type;
          this.detail = detail;
        }
      },
    },
  );
  const jsx = (type, props) => ({ type, props });
  const t = (key) => key;
  const { SelectionActions } = load("../src/components/Layout/SelectionActions.tsx", {
    react: {
      useRef: () => ({ current: null }),
      useState: (initial) => [initial, () => {}],
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "../../i18n": { useI18n: () => ({ t }) },
    "../../i18n/searchTime": { useSearchTimeI18n: () => t },
    "../../i18n/albumPicker": { useAlbumPickerLabels: () => ({}) },
    "../../api/time": time,
  });
  const tree = SelectionActions({
    selectedAssetIds: ["first", "second"],
    selectedCount: 2,
    variant,
    stopPropagation: variant === "preview",
  });
  const menu = tree.props.children.find((child) => child?.props?.className?.includes("ml-auto"));
  const button = menu.props.children[1].props.children[0].props.children;
  const summary = { focus: () => calls.push("focus") };
  const element = {
    open: true,
    contains: (target) => target === summary || target === button,
    querySelector: () => summary,
  };
  menu.props.ref.current = element;
  return { menu, button, element, requests, calls };
}

for (const variant of ["topbar", "preview"]) {
  test(`${variant}: WebKit clicks open time editing for all selected assets`, () => {
    const { menu, button, element, requests } = renderActions(variant);
    let prevented = false;
    menu.props.onMouseDown?.({
      button: 0,
      target: { closest: () => button },
      preventDefault: () => {
        prevented = true;
      },
    });
    // WebKit blurs the summary without focusing the button before click.
    if (!prevented) {
      menu.props.onBlur({ currentTarget: element, relatedTarget: null });
    }
    assert.equal(element.open, true, "the option must stay visible until click");
    button.props.onClick({ stopPropagation() {} });
    assert.equal(element.open, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].type, "immich:fix-time");
    assert.deepEqual(Array.from(requests[0].detail.assetIds), ["first", "second"]);
  });
}

test("time menu retains keyboard focus and dismisses on outside focus or Escape", () => {
  const { menu, button, element, calls } = renderActions("topbar");
  menu.props.onBlur({ currentTarget: element, relatedTarget: button });
  assert.equal(element.open, true);
  menu.props.onBlur({ currentTarget: element, relatedTarget: null });
  assert.equal(element.open, false);
  element.open = true;
  menu.props.onKeyDown({ key: "Escape", stopPropagation() {} });
  assert.equal(element.open, false);
  assert.deepEqual(calls, ["focus"]);
});
