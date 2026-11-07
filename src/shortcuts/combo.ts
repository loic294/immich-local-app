/**
 * Platform-agnostic keyboard combos.
 *
 * A combo is a canonical string such as `Mod+Shift+F` or `Delete`:
 * - `Mod` is Cmd on macOS and Ctrl on Windows.
 * - `Ctrl` is the physical Control key on macOS only (Windows treats Ctrl as `Mod`).
 * - Modifiers are always written in the order Mod, Ctrl, Alt, Shift, followed by one key.
 */

export interface ParsedCombo {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export interface KeyboardEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?: (modifier: string) => boolean;
}

const NAMED_KEYS = [
  "Escape",
  "Enter",
  "Delete",
  "Backspace",
  "Tab",
  "Space",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Insert",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
];
const NAMED_KEY_LOOKUP = new Map(NAMED_KEYS.map((name) => [name.toLowerCase(), name]));

const PUNCTUATION_KEYS = new Set([",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`"]);

const PUNCTUATION_BY_CODE: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

const MODIFIER_KEY_NAMES = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "AltGraph",
  "OS",
  "Super",
  "Hyper",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "FnLock",
]);

/** Combos the app never lets users assign: OS/clipboard/window commands and focus navigation. */
const RESERVED_COMBOS = new Set([
  "Mod+C",
  "Mod+V",
  "Mod+X",
  "Mod+Z",
  "Mod+Shift+Z",
  "Mod+Y",
  "Mod+Q",
  "Mod+W",
  "Mod+H",
  "Mod+M",
  "Mod+Alt+H",
  "Alt+F4",
  "Tab",
  "Shift+Tab",
  "Enter",
  "Space",
]);

const TEXT_EDITING_KEYS = new Set([
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

function normalizeKeyToken(token: string): string | null {
  if (token.length === 1) {
    if (/^[a-z0-9]$/i.test(token)) {
      return token.toUpperCase();
    }
    return PUNCTUATION_KEYS.has(token) ? token : null;
  }
  return NAMED_KEY_LOOKUP.get(token.toLowerCase()) ?? null;
}

export function parseCombo(combo: unknown): ParsedCombo | null {
  if (typeof combo !== "string") {
    return null;
  }
  // A literal "+" key cannot be expressed (tokens are split on "+"), so it is never valid.
  const tokens = combo.split("+").map((token) => token.trim());
  const keyToken = tokens.pop();
  const key = keyToken ? normalizeKeyToken(keyToken) : null;
  if (!key) {
    return null;
  }

  const parsed: ParsedCombo = { mod: false, ctrl: false, alt: false, shift: false, key };
  for (const token of tokens) {
    const name = token.toLowerCase();
    if (name !== "mod" && name !== "ctrl" && name !== "alt" && name !== "shift") {
      return null;
    }
    if (parsed[name]) {
      return null;
    }
    parsed[name] = true;
  }
  return parsed;
}

export function serializeCombo(parsed: ParsedCombo): string {
  const parts: string[] = [];
  if (parsed.mod) parts.push("Mod");
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key);
  return parts.join("+");
}

export function normalizeCombo(combo: unknown): string | null {
  const parsed = parseCombo(combo);
  return parsed ? serializeCombo(parsed) : null;
}

/** Normalizes every entry, dropping invalid values and duplicates while keeping order. */
export function normalizeComboList(combos: unknown): string[] {
  if (!Array.isArray(combos)) {
    return [];
  }
  const result: string[] = [];
  for (const combo of combos) {
    const normalized = normalizeCombo(combo);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function keyFromCode(code: string | undefined): string | null {
  if (!code) {
    return null;
  }
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) {
    return letter[1];
  }
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) {
    return digit[1];
  }
  return PUNCTUATION_BY_CODE[code] ?? null;
}

/**
 * Resolves the logical key of an event. Printable keys prefer `event.key`, and fall back to the
 * physical `event.code` when modifiers or dead keys compose a different character (for example
 * Option+F producing "ƒ" on macOS, or Shift+1 producing "!").
 */
export function keyFromEvent(event: Pick<KeyboardEventLike, "key" | "code">): string | null {
  const { key } = event;
  if (!key || MODIFIER_KEY_NAMES.has(key)) {
    return null;
  }
  if (key === " ") {
    return "Space";
  }
  if (key.length === 1) {
    if (/^[a-z0-9]$/i.test(key)) {
      return key.toUpperCase();
    }
    if (PUNCTUATION_KEYS.has(key)) {
      return key;
    }
    return keyFromCode(event.code);
  }
  const named = NAMED_KEY_LOOKUP.get(key.toLowerCase());
  if (named) {
    return named;
  }
  if (key === "Dead" || key === "Unidentified") {
    return keyFromCode(event.code);
  }
  return null;
}

/** Returns the canonical combo for a key event, or null when the event is not a usable combo. */
export function eventToCombo(event: KeyboardEventLike, isMac: boolean): string | null {
  const key = keyFromEvent(event);
  if (!key) {
    return null;
  }
  if (!isMac && event.metaKey) {
    return null;
  }
  // AltGr reports Ctrl+Alt on Windows; it composes characters and must never trigger shortcuts.
  if (event.getModifierState?.("AltGraph")) {
    return null;
  }
  return serializeCombo({
    mod: isMac ? event.metaKey : event.ctrlKey,
    ctrl: isMac ? event.ctrlKey : false,
    alt: event.altKey,
    shift: event.shiftKey,
    key,
  });
}

export function hasPrimaryModifier(combo: string): boolean {
  const parsed = parseCombo(combo);
  return !!parsed && (parsed.mod || parsed.ctrl || parsed.alt);
}

export function isReservedCombo(combo: string): boolean {
  const normalized = normalizeCombo(combo);
  return !normalized || RESERVED_COMBOS.has(normalized);
}

/** Combos that edit text while typing; they can never trigger actions from inside a text field. */
export function isTextEditingCombo(combo: string): boolean {
  const parsed = parseCombo(combo);
  if (!parsed || !(parsed.mod || parsed.ctrl)) {
    return false;
  }
  if (parsed.key === "A") {
    return !parsed.shift && !parsed.alt;
  }
  return TEXT_EDITING_KEYS.has(parsed.key);
}

const MAC_KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "Esc",
  Enter: "↩",
  Tab: "⇥",
  PageUp: "Page Up",
  PageDown: "Page Down",
};

const WINDOWS_KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Delete: "Del",
  Escape: "Esc",
  PageUp: "Page Up",
  PageDown: "Page Down",
};

/** Human-readable label: `⌘⇧F` on macOS, `Ctrl+Shift+F` on Windows. */
export function formatCombo(combo: string, isMac: boolean): string {
  const parsed = parseCombo(combo);
  if (!parsed) {
    return combo;
  }
  const keyLabel = (isMac ? MAC_KEY_LABELS : WINDOWS_KEY_LABELS)[parsed.key] ?? parsed.key;
  if (isMac) {
    return `${parsed.ctrl ? "⌃" : ""}${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}${
      parsed.mod ? "⌘" : ""
    }${keyLabel}`;
  }
  const parts: string[] = [];
  if (parsed.mod || parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(keyLabel);
  return parts.join("+");
}

/** Converts a combo to the accelerator syntax understood by the native menu (muda). */
export function comboToAccelerator(combo: string): string | null {
  const parsed = parseCombo(combo);
  if (!parsed) {
    return null;
  }
  const parts: string[] = [];
  if (parsed.mod) parts.push("CmdOrCtrl");
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key);
  return parts.join("+");
}

/**
 * Picks the binding shown as the native menu accelerator. Bare-key and Shift-only bindings are
 * JavaScript-only: as native accelerators they would hijack plain typing.
 */
export function getNativeAccelerator(combos: readonly string[]): string | null {
  for (const combo of combos) {
    if (hasPrimaryModifier(combo) && !isReservedCombo(combo)) {
      return comboToAccelerator(combo);
    }
  }
  return null;
}
