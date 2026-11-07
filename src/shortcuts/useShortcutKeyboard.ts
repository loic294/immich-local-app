import { useEffect, useLayoutEffect, useRef } from "react";
import type { ShortcutBindings } from "./catalog";
import { shortcutRegistry } from "./shortcutRegistry";

/**
 * The app's single global keyboard listener. It runs in the bubble phase on `window`, so dialogs
 * and menus that stop propagation keep their keys, and any component that already handled a key
 * (`preventDefault`) wins over a shortcut.
 */
export function useShortcutKeyboard(bindings: ShortcutBindings): void {
  const bindingsRef = useRef(bindings);

  useLayoutEffect(() => {
    bindingsRef.current = bindings;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      shortcutRegistry.handleKeyDown(event, bindingsRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
