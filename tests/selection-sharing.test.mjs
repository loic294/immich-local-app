import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/components/Layout/SelectionActions.tsx", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
});

function renderActions(props) {
  const calls = [];
  const updates = [];
  const jsx = (type, props) => ({ type, props });
  const t = (key) => key;
  const modules = {
    react: {
      useRef: () => ({ current: null }),
      useState: (initial) => [initial, (value) => updates.push(value)],
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "../../i18n": { useI18n: () => ({ t }) },
    "../../i18n/searchTime": { useSearchTimeI18n: () => t },
    "../../i18n/albumPicker": { useAlbumPickerLabels: () => ({}) },
    "../../api/tauri": {
      copyAssetsToClipboard: async (ids) => calls.push(["clipboard", ids]),
      getSettings: async () => {
        calls.push(["folder"]);
        return { userLocalFolderPath: "" };
      },
    },
    "@tauri-apps/plugin-dialog": {
      open: async (options) => {
        calls.push(["usb", options]);
        return null;
      },
    },
  };
  const exports = {};
  runInNewContext(outputText, {
    exports,
    require: (name) => modules[name] ?? {},
    console,
  });
  const tree = exports.SelectionActions({
    selectedAssetIds: ["asset"],
    selectedCount: 1,
    ...props,
  });
  const menu = tree.props.children.find((child) => child?.type === "details");
  const buttons = menu.props.children[1].props.children.map((item) => item.props.children);
  const summary = { focus: () => calls.push(["focus"]) };
  const element = {
    open: true,
    contains: (target) => target === summary || buttons.includes(target),
    querySelector: () => summary,
  };
  menu.props.ref.current = element;
  return { menu, buttons, element, calls, updates };
}

for (const variant of ["topbar", "preview"]) {
  for (const [index, action] of ["link", "clipboard", "folder", "usb"].entries()) {
    test(`${variant}: a WebKit pointer click activates the ${action} share option`, async () => {
      const { menu, buttons, element, calls, updates } = renderActions({
        variant,
        stopPropagation: variant === "preview",
      });
      let defaultPrevented = false;
      // WebKit does not focus buttons on mouse-down. Without prevention, the
      // summary blurs to null and the menu disappears before click dispatch.
      menu.props.onMouseDown?.({
        button: 0,
        target: { closest: () => buttons[index] },
        preventDefault: () => {
          defaultPrevented = true;
        },
      });
      if (!defaultPrevented) {
        menu.props.onBlur({ currentTarget: element, relatedTarget: null });
      }
      assert.equal(element.open, true, "the option must remain visible until click");
      buttons[index].props.onClick();
      menu.props.onClick({
        target: { closest: () => buttons[index] },
        stopPropagation() {},
      });
      await Promise.resolve();
      assert.equal(element.open, false, "the menu closes after activation");
      if (action === "link") assert.ok(updates.includes(true), "opens the share dialog");
      else assert.equal(calls[0]?.[0], action);
      if (action === "clipboard") assert.deepEqual(Array.from(calls[0][1]), ["asset"]);
      if (action === "usb") {
        assert.deepEqual({ ...calls[0][1] }, { directory: true, multiple: false });
      }
    });
  }
}

test("share menu retains internal keyboard focus and dismisses on outside focus or Escape", () => {
  const { menu, buttons, element, calls } = renderActions();
  menu.props.onBlur({ currentTarget: element, relatedTarget: buttons[0] });
  assert.equal(element.open, true);
  menu.props.onBlur({ currentTarget: element, relatedTarget: null });
  assert.equal(element.open, false);
  element.open = true;
  menu.props.onKeyDown({ key: "Escape", stopPropagation() {} });
  assert.equal(element.open, false);
  assert.deepEqual(calls, [["focus"]]);
});
