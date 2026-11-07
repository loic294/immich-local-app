import { useEffect, useLayoutEffect, useRef } from "react";
import { eventToCombo } from "../shortcuts/combo";
import { IS_MAC, shortcutRegistry } from "../shortcuts/shortcutRegistry";

interface ShortcutRecorderOptions {
  active: boolean;
  onCombo: (combo: string) => void;
  onCancel: () => void;
}

/**
 * While `active`, captures key combinations for the shortcut settings. The global handler is
 * paused so the pressed keys never run their actions, and the native menu accelerators are
 * suspended with it. A plain Escape cancels.
 */
export function useShortcutRecorder({ active, onCombo, onCancel }: ShortcutRecorderOptions): void {
  const callbacksRef = useRef({ onCombo, onCancel });

  useLayoutEffect(() => {
    callbacksRef.current = { onCombo, onCancel };
  });

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const endCapture = shortcutRegistry.beginCapture();

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || event.isComposing) {
        return;
      }
      const hasModifier = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
      if (event.key === "Escape" && !hasModifier) {
        callbacksRef.current.onCancel();
        return;
      }
      const combo = eventToCombo(event, IS_MAC);
      if (combo) {
        callbacksRef.current.onCombo(combo);
      }
    };
    // Space and Enter activate a focused button on key release, which must not restart recording.
    const swallowKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", swallowKeyUp, true);
    console.info("[shortcuts.settings] recording a shortcut");
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", swallowKeyUp, true);
      endCapture();
    };
  }, [active]);
}
