import { useEffect, useLayoutEffect, useRef } from "react";
import type { ShortcutActionId, ShortcutScope } from "./catalog";
import type { ShortcutHandler } from "./registry";
import { shortcutRegistry } from "./shortcutRegistry";

interface UseShortcutHandlerOptions {
  /** While false the action is not registered, so its key does nothing and its menu item is disabled. */
  enabled?: boolean;
  /** Where the handler applies: the photo grid (`browse`), the photo viewer, or everywhere. */
  scope?: ShortcutScope;
}

/**
 * Registers `handler` for a shortcut action while the calling component is mounted. The latest
 * handler is always the one that runs, so callers can pass inline closures without re-registering.
 * Return `false` from the handler to decline and let the next registered handler take over.
 */
export function useShortcutHandler(
  actionId: ShortcutActionId,
  handler: ShortcutHandler,
  { enabled = true, scope = "browse" }: UseShortcutHandlerOptions = {},
): void {
  const handlerRef = useRef(handler);

  useLayoutEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    return shortcutRegistry.register(actionId, () => handlerRef.current(), scope);
  }, [actionId, enabled, scope]);
}

type ShortcutHandlerMap = Partial<Record<ShortcutActionId, ShortcutHandler | undefined>>;

/**
 * Registers several actions at once. An action whose entry is `undefined` is not registered, which
 * is how callers switch a single action off (its key does nothing and its menu item is disabled).
 */
export function useShortcutHandlers(
  handlers: ShortcutHandlerMap,
  { enabled = true, scope = "browse" }: UseShortcutHandlerOptions = {},
): void {
  const handlersRef = useRef(handlers);

  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });

  const registeredKey = Object.entries(handlers)
    .filter(([, handler]) => handler !== undefined)
    .map(([actionId]) => actionId)
    .sort()
    .join(",");

  useEffect(() => {
    if (!enabled || registeredKey === "") {
      return undefined;
    }
    const unregister = (registeredKey.split(",") as ShortcutActionId[]).map((actionId) =>
      shortcutRegistry.register(actionId, () => handlersRef.current[actionId]?.(), scope),
    );
    return () => unregister.forEach((stop) => stop());
  }, [registeredKey, enabled, scope]);
}
