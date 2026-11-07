import { getShortcutAction, SHORTCUT_ACTIONS } from "./catalog";
import type { ShortcutActionId, ShortcutBindings, ShortcutContext, ShortcutScope } from "./catalog";
import { eventToCombo, isTextEditingCombo, parseCombo } from "./combo";
import type { KeyboardEventLike } from "./combo";

export type ShortcutSource = "keyboard" | "menu";

/** Return `false` to decline, so the next registered handler (or the browser) takes over. */
export type ShortcutHandler = () => boolean | void | Promise<unknown>;

export interface ShortcutKeyEvent extends KeyboardEventLike {
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
  preventDefault(): void;
}

export interface ShortcutEnvironment {
  isMac: boolean;
  getContext(): ShortcutContext;
  isModalOpen(): boolean;
  isEditableTarget(target: EventTarget | null): boolean;
  blurEditable?(target: EventTarget | null): void;
  now?(): number;
}

/** A menu accelerator and the keyboard handler can both fire for one key press; keep one. */
const DEDUPE_WINDOW_MS = 150;

interface Registration {
  actionId: ShortcutActionId;
  scope: ShortcutScope;
  handler: ShortcutHandler;
}

interface LastRun {
  actionId: ShortcutActionId;
  source: ShortcutSource;
  at: number;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === "function";
}

function canRunWhileTyping(actionId: ShortcutActionId, combo: string): boolean {
  if (!getShortcutAction(actionId)?.allowWhileTyping) {
    return false;
  }
  const parsed = parseCombo(combo);
  return !!parsed && (parsed.mod || parsed.ctrl) && !isTextEditingCombo(combo);
}

/**
 * The single place where keyboard shortcuts and native menu actions are resolved into handlers.
 *
 * Components register handlers per action and scope. A handler is eligible when its scope is
 * `global` or matches the current context (`browse` or `viewer`). Context-specific handlers win
 * over `global` ones, and newer registrations win over older ones.
 */
export function createShortcutRegistry(env: ShortcutEnvironment) {
  const registrations: Registration[] = [];
  const availabilityListeners = new Set<() => void>();
  const captureListeners = new Set<() => void>();
  const indexCache = new WeakMap<object, Map<string, ShortcutActionId[]>>();
  const now = () => (env.now ? env.now() : Date.now());
  let captureDepth = 0;
  let lastRun: LastRun | null = null;
  let availabilityNotificationQueued = false;

  function queueAvailabilityNotification() {
    if (availabilityNotificationQueued) {
      return;
    }
    availabilityNotificationQueued = true;
    void Promise.resolve().then(() => {
      availabilityNotificationQueued = false;
      for (const listener of [...availabilityListeners]) {
        listener();
      }
    });
  }

  function getComboIndex(bindings: ShortcutBindings): Map<string, ShortcutActionId[]> {
    let index = indexCache.get(bindings);
    if (!index) {
      index = new Map();
      for (const action of SHORTCUT_ACTIONS) {
        for (const combo of bindings[action.id] ?? []) {
          const actionIds = index.get(combo);
          if (actionIds) {
            actionIds.push(action.id);
          } else {
            index.set(combo, [action.id]);
          }
        }
      }
      indexCache.set(bindings, index);
    }
    return index;
  }

  function getCandidates(actionIds: readonly ShortcutActionId[]): Registration[] {
    const context = env.getContext();
    const specific: Registration[] = [];
    const fallback: Registration[] = [];
    for (let index = registrations.length - 1; index >= 0; index -= 1) {
      const registration = registrations[index];
      if (!actionIds.includes(registration.actionId)) {
        continue;
      }
      if (registration.scope === "global") {
        fallback.push(registration);
      } else if (registration.scope === context) {
        specific.push(registration);
      }
    }
    return specific.concat(fallback);
  }

  function isDuplicate(actionId: ShortcutActionId, source: ShortcutSource): boolean {
    return (
      !!lastRun &&
      lastRun.actionId === actionId &&
      lastRun.source !== source &&
      now() - lastRun.at < DEDUPE_WINDOW_MS
    );
  }

  function run(candidates: readonly Registration[], source: ShortcutSource): boolean {
    for (const registration of candidates) {
      const { actionId } = registration;
      let result: unknown;
      try {
        result = registration.handler();
      } catch (error) {
        console.error(`[shortcuts] ${actionId} handler failed (${source})`, error);
        lastRun = { actionId, source, at: now() };
        return true;
      }
      if (result === false) {
        continue;
      }
      if (isPromiseLike(result)) {
        result.then(undefined, (error: unknown) => {
          console.error(`[shortcuts] ${actionId} handler rejected (${source})`, error);
        });
      }
      if (!getShortcutAction(actionId)?.repeatable) {
        console.debug(`[shortcuts] ${actionId} triggered (${source}, ${registration.scope})`);
      }
      lastRun = { actionId, source, at: now() };
      return true;
    }
    return false;
  }

  function register(
    actionId: ShortcutActionId,
    handler: ShortcutHandler,
    scope: ShortcutScope = "browse",
  ): () => void {
    const registration: Registration = { actionId, scope, handler };
    registrations.push(registration);
    queueAvailabilityNotification();
    return () => {
      const index = registrations.indexOf(registration);
      if (index >= 0) {
        registrations.splice(index, 1);
        queueAvailabilityNotification();
      }
    };
  }

  /** Resolves a key press. Returns true when the event was consumed (and default-prevented). */
  function handleKeyDown(event: ShortcutKeyEvent, bindings: ShortcutBindings): boolean {
    if (event.defaultPrevented || event.isComposing || captureDepth > 0) {
      return false;
    }
    const combo = eventToCombo(event, env.isMac);
    if (!combo) {
      return false;
    }
    const actionIds = getComboIndex(bindings).get(combo);
    if (!actionIds) {
      return false;
    }
    let candidates = getCandidates(actionIds);
    if (candidates.length === 0 || env.isModalOpen()) {
      return false;
    }

    if (env.isEditableTarget(event.target ?? null)) {
      if (combo === "Escape") {
        // First Escape leaves the text field; the next one reaches the registered action.
        env.blurEditable?.(event.target ?? null);
        event.preventDefault();
        return true;
      }
      candidates = candidates.filter((candidate) => canRunWhileTyping(candidate.actionId, combo));
      if (candidates.length === 0) {
        return false;
      }
    }

    if (event.repeat) {
      // Swallow auto-repeat so one-shot actions are neither re-fired nor handed to the native menu.
      candidates = candidates.filter(
        (candidate) => getShortcutAction(candidate.actionId)?.repeatable,
      );
      if (candidates.length === 0) {
        event.preventDefault();
        return true;
      }
    } else if (candidates.some((candidate) => isDuplicate(candidate.actionId, "keyboard"))) {
      event.preventDefault();
      return true;
    }

    if (run(candidates, "keyboard")) {
      event.preventDefault();
      return true;
    }
    return false;
  }

  /** Runs an action requested by the native menu. */
  function dispatch(actionId: ShortcutActionId, source: ShortcutSource = "menu"): boolean {
    if (env.isModalOpen()) {
      console.debug(`[shortcuts] ${actionId} ignored (${source}): a dialog is open`);
      return false;
    }
    const candidates = getCandidates([actionId]);
    if (candidates.length === 0) {
      console.debug(`[shortcuts] ${actionId} ignored (${source}): no handler in this view`);
      return false;
    }
    if (isDuplicate(actionId, source)) {
      return true;
    }
    return run(candidates, source);
  }

  function getAvailableActionIds(): Set<ShortcutActionId> {
    const context = env.getContext();
    const available = new Set<ShortcutActionId>();
    for (const registration of registrations) {
      if (registration.scope === "global" || registration.scope === context) {
        available.add(registration.actionId);
      }
    }
    return available;
  }

  function subscribeAvailability(listener: () => void): () => void {
    availabilityListeners.add(listener);
    return () => {
      availabilityListeners.delete(listener);
    };
  }

  function notifyCaptureListeners() {
    for (const listener of [...captureListeners]) {
      listener();
    }
  }

  /** Suspends keyboard dispatch while the settings recorder listens for a new combo. */
  function beginCapture(): () => void {
    captureDepth += 1;
    notifyCaptureListeners();
    let ended = false;
    return () => {
      if (ended) {
        return;
      }
      ended = true;
      captureDepth -= 1;
      notifyCaptureListeners();
    };
  }

  function subscribeCapture(listener: () => void): () => void {
    captureListeners.add(listener);
    return () => {
      captureListeners.delete(listener);
    };
  }

  return {
    register,
    handleKeyDown,
    dispatch,
    getAvailableActionIds,
    subscribeAvailability,
    beginCapture,
    isCaptureActive: () => captureDepth > 0,
    subscribeCapture,
  };
}

export type ShortcutRegistry = ReturnType<typeof createShortcutRegistry>;
