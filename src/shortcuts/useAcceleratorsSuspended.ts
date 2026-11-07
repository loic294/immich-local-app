import { useEffect, useState } from "react";
import { isEditableTarget } from "./dom";
import { shortcutRegistry } from "./shortcutRegistry";

/**
 * True while keys belong to a text field or to the shortcut recorder. Native menu accelerators
 * are withheld then, because on macOS a key the page declines is offered to the menu bar.
 */
export function useAcceleratorsSuspended(): boolean {
  const [typing, setTyping] = useState(() => isEditableTarget(document.activeElement));
  const [recording, setRecording] = useState(() => shortcutRegistry.isCaptureActive());

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => setTyping(isEditableTarget(event.target));
    const onFocusOut = (event: FocusEvent) => setTyping(isEditableTarget(event.relatedTarget));
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    const stopCaptureWatch = shortcutRegistry.subscribeCapture(() =>
      setRecording(shortcutRegistry.isCaptureActive()),
    );
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      stopCaptureWatch();
    };
  }, []);

  return typing || recording;
}
