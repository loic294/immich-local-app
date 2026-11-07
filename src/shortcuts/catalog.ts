import { isReservedCombo, isTextEditingCombo, normalizeCombo, normalizeComboList } from "./combo";

/** The state of the UI that decides which registered handlers can run. */
export type ShortcutContext = "browse" | "viewer";

/** Where a handler is registered. `global` handlers run in every context, as a fallback. */
export type ShortcutScope = ShortcutContext | "global";

export type ShortcutGroup = "photos" | "viewer" | "selection" | "view" | "albums" | "navigation";

export const SHORTCUT_GROUP_ORDER: readonly ShortcutGroup[] = [
  "photos",
  "viewer",
  "selection",
  "view",
  "albums",
  "navigation",
];

export interface ShortcutActionDefinition {
  readonly id: string;
  readonly group: ShortcutGroup;
  readonly defaults: readonly string[];
  /** Contexts in which the action can fire; only used to detect binding conflicts. */
  readonly contexts: readonly ShortcutScope[];
  /** Held keys keep firing the action (arrow navigation). Everything else fires once. */
  readonly repeatable?: boolean;
  /** Fires from inside text fields, but only for bindings with a Mod/Ctrl modifier. */
  readonly allowWhileTyping?: boolean;
}

export const SHORTCUT_ACTIONS = [
  {
    id: "photo.favorite",
    group: "photos",
    defaults: ["F", "Mod+D"],
    contexts: ["browse", "viewer"],
  },
  {
    id: "photo.delete",
    group: "photos",
    defaults: ["Delete", "Backspace", "Mod+Backspace"],
    contexts: ["browse", "viewer"],
  },
  {
    id: "photo.addToAlbum",
    group: "photos",
    defaults: ["A", "Mod+Shift+A"],
    contexts: ["browse", "viewer"],
  },
  {
    id: "photo.share",
    group: "photos",
    defaults: ["S", "Mod+Shift+S"],
    contexts: ["browse", "viewer"],
  },
  {
    id: "photo.fixTime",
    group: "photos",
    defaults: ["T"],
    contexts: ["browse", "viewer"],
  },
  {
    id: "photo.copyToClipboard",
    group: "photos",
    defaults: ["Mod+Shift+C"],
    contexts: ["browse", "viewer"],
  },
  {
    id: "photo.showInFolder",
    group: "photos",
    defaults: ["Mod+Shift+E"],
    contexts: ["browse", "viewer"],
  },
  {
    id: "photo.copyToFolder",
    group: "photos",
    defaults: ["Mod+Shift+U"],
    contexts: ["browse", "viewer"],
  },
  { id: "photo.edit", group: "viewer", defaults: ["E"], contexts: ["viewer"] },
  { id: "photo.toggleInfo", group: "viewer", defaults: ["I"], contexts: ["viewer"] },
  { id: "photo.rate0", group: "viewer", defaults: ["0"], contexts: ["viewer"] },
  { id: "photo.rate1", group: "viewer", defaults: ["1"], contexts: ["viewer"] },
  { id: "photo.rate2", group: "viewer", defaults: ["2"], contexts: ["viewer"] },
  { id: "photo.rate3", group: "viewer", defaults: ["3"], contexts: ["viewer"] },
  { id: "photo.rate4", group: "viewer", defaults: ["4"], contexts: ["viewer"] },
  { id: "photo.rate5", group: "viewer", defaults: ["5"], contexts: ["viewer"] },
  {
    id: "view.previous",
    group: "viewer",
    defaults: ["ArrowLeft"],
    contexts: ["viewer"],
    repeatable: true,
  },
  {
    id: "view.next",
    group: "viewer",
    defaults: ["ArrowRight"],
    contexts: ["viewer"],
    repeatable: true,
  },
  { id: "view.close", group: "viewer", defaults: ["Escape"], contexts: ["viewer"] },
  {
    id: "selection.selectAll",
    group: "selection",
    defaults: ["Mod+A"],
    contexts: ["browse"],
  },
  { id: "selection.clear", group: "selection", defaults: ["Escape"], contexts: ["browse"] },
  {
    id: "view.focusSearch",
    group: "view",
    defaults: ["Mod+F", "/"],
    contexts: ["browse"],
    allowWhileTyping: true,
  },
  { id: "view.toggleFilter", group: "view", defaults: ["Shift+F"], contexts: ["browse"] },
  { id: "view.sortDirection", group: "view", defaults: ["O"], contexts: ["browse"] },
  { id: "view.sortField", group: "view", defaults: ["Shift+O"], contexts: ["browse"] },
  {
    id: "album.create",
    group: "albums",
    defaults: ["Mod+N"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
  {
    id: "nav.photos",
    group: "navigation",
    defaults: ["Mod+1"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
  {
    id: "nav.albums",
    group: "navigation",
    defaults: ["Mod+2"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
  {
    id: "nav.favorites",
    group: "navigation",
    defaults: ["Mod+3"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
  {
    id: "nav.people",
    group: "navigation",
    defaults: ["Mod+4"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
  {
    id: "nav.maps",
    group: "navigation",
    defaults: ["Mod+5"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
  {
    id: "nav.calendar",
    group: "navigation",
    defaults: ["Mod+6"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
  {
    id: "nav.folders",
    group: "navigation",
    defaults: ["Mod+7"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
  {
    id: "nav.phonePhotos",
    group: "navigation",
    defaults: ["Mod+8"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
  {
    id: "nav.deleted",
    group: "navigation",
    defaults: ["Mod+9"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
  {
    id: "nav.settings",
    group: "navigation",
    defaults: ["Mod+,"],
    contexts: ["global"],
    allowWhileTyping: true,
  },
] as const satisfies readonly ShortcutActionDefinition[];

export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]["id"];

export type ShortcutBindings = Readonly<Record<ShortcutActionId, readonly string[]>>;

/** Only the actions whose bindings differ from the defaults are persisted. */
export type ShortcutOverrides = Record<string, string[]>;

const ACTIONS_BY_ID = new Map<string, ShortcutActionDefinition>(
  SHORTCUT_ACTIONS.map((action): [string, ShortcutActionDefinition] => [action.id, action]),
);

export function getShortcutAction(id: string): ShortcutActionDefinition | undefined {
  return ACTIONS_BY_ID.get(id);
}

export function isShortcutActionId(value: unknown): value is ShortcutActionId {
  return typeof value === "string" && ACTIONS_BY_ID.has(value);
}

function cleanBindingList(combos: unknown): string[] {
  return normalizeComboList(combos).filter((combo) => !isReservedCombo(combo));
}

/**
 * Merges the user's overrides over the defaults. Unknown actions are ignored, invalid or reserved
 * combos are dropped, and an empty override list leaves the action unbound.
 */
export function resolveBindings(overrides?: Record<string, unknown> | null): ShortcutBindings {
  const source: Record<string, unknown> =
    overrides && typeof overrides === "object" ? overrides : {};
  const result = {} as Record<ShortcutActionId, readonly string[]>;
  for (const action of SHORTCUT_ACTIONS) {
    const override = Object.prototype.hasOwnProperty.call(source, action.id)
      ? source[action.id]
      : undefined;
    result[action.id] = cleanBindingList(Array.isArray(override) ? override : action.defaults);
  }
  return result;
}

export const DEFAULT_BINDINGS: ShortcutBindings = resolveBindings(null);

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function diffOverrides(bindings: ShortcutBindings): ShortcutOverrides {
  const overrides: ShortcutOverrides = {};
  for (const action of SHORTCUT_ACTIONS) {
    if (!sameList(bindings[action.id], DEFAULT_BINDINGS[action.id])) {
      overrides[action.id] = [...bindings[action.id]];
    }
  }
  return overrides;
}

export function isDefaultBinding(bindings: ShortcutBindings, actionId: ShortcutActionId): boolean {
  return sameList(bindings[actionId], DEFAULT_BINDINGS[actionId]);
}

function contextsOverlap(left: readonly ShortcutScope[], right: readonly ShortcutScope[]): boolean {
  return left.some((a) => right.some((b) => a === b || a === "global" || b === "global"));
}

/** Other actions that already use `combo` in a context where both could fire. */
export function findConflicts(
  bindings: ShortcutBindings,
  actionId: ShortcutActionId,
  combo: string,
): ShortcutActionId[] {
  const normalized = normalizeCombo(combo);
  const action = getShortcutAction(actionId);
  if (!normalized || !action) {
    return [];
  }
  const conflicts: ShortcutActionId[] = [];
  for (const other of SHORTCUT_ACTIONS) {
    if (
      other.id !== actionId &&
      bindings[other.id].includes(normalized) &&
      contextsOverlap(action.contexts, other.contexts)
    ) {
      conflicts.push(other.id);
    }
  }
  return conflicts;
}

export type ComboRejection = "invalid" | "reserved" | "textEditing";

/** Why a combo cannot be assigned to an action, or null when it is acceptable. */
export function getComboRejection(
  actionId: ShortcutActionId,
  combo: string,
): ComboRejection | null {
  const normalized = normalizeCombo(combo);
  if (!normalized) {
    return "invalid";
  }
  if (isReservedCombo(normalized)) {
    return "reserved";
  }
  if (getShortcutAction(actionId)?.allowWhileTyping && isTextEditingCombo(normalized)) {
    return "textEditing";
  }
  return null;
}

export function withBinding(
  bindings: ShortcutBindings,
  actionId: ShortcutActionId,
  combo: string,
): ShortcutBindings {
  const normalized = normalizeCombo(combo);
  if (!normalized || bindings[actionId].includes(normalized)) {
    return bindings;
  }
  return { ...bindings, [actionId]: [...bindings[actionId], normalized] };
}

export function withoutBinding(
  bindings: ShortcutBindings,
  actionId: ShortcutActionId,
  combo: string,
): ShortcutBindings {
  return { ...bindings, [actionId]: bindings[actionId].filter((value) => value !== combo) };
}

/** Removes `combo` from every action that would conflict with `actionId` using it. */
export function withoutConflicts(
  bindings: ShortcutBindings,
  actionId: ShortcutActionId,
  combo: string,
): ShortcutBindings {
  let next = bindings;
  for (const conflictId of findConflicts(bindings, actionId, combo)) {
    next = withoutBinding(next, conflictId, combo);
  }
  return next;
}

/** Restores the defaults of one action, taking the default combos back from conflicting actions. */
export function resetBinding(
  bindings: ShortcutBindings,
  actionId: ShortcutActionId,
): ShortcutBindings {
  let next: ShortcutBindings = { ...bindings, [actionId]: [...DEFAULT_BINDINGS[actionId]] };
  for (const combo of DEFAULT_BINDINGS[actionId]) {
    next = withoutConflicts(next, actionId, combo);
  }
  return next;
}
