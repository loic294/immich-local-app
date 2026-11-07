import type { ShortcutContext } from "./catalog";

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "image",
  "file",
  "color",
  "hidden",
]);

/**
 * Anything that overlays the app and owns the keyboard: native dialogs, daisyUI modals, ARIA
 * dialogs, and custom overlays marked with `data-shortcut-modal`. The photo viewer is itself an
 * ARIA dialog, but it is the context shortcuts operate in, so it is marked `data-shortcut-viewer`.
 */
const MODAL_SELECTOR = [
  "dialog[open]",
  ".modal-open",
  "[role='dialog'][aria-modal='true']:not([data-shortcut-viewer])",
  "[role='alertdialog']",
  "[data-shortcut-modal]",
].join(", ");

export const SHORTCUT_VIEWER_ATTRIBUTE = "data-shortcut-viewer";
export const SHORTCUT_MODAL_ATTRIBUTE = "data-shortcut-modal";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") {
    return true;
  }
  if (target.tagName === "INPUT") {
    return !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type);
  }
  return false;
}

export function blurEditable(target: EventTarget | null): void {
  if (target instanceof HTMLElement) {
    target.blur();
  }
}

/** True while a visible dialog is open; elements that are mounted but hidden do not count. */
export function isModalOpen(): boolean {
  const candidates = document.querySelectorAll(MODAL_SELECTOR);
  for (const element of Array.from(candidates)) {
    if (element.getClientRects().length > 0) {
      return true;
    }
  }
  return false;
}

export function getShortcutContext(): ShortcutContext {
  return document.querySelector(`[${SHORTCUT_VIEWER_ATTRIBUTE}]`) ? "viewer" : "browse";
}
