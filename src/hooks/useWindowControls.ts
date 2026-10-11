import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function isMacWindow(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

type WindowAction = "minimize" | "toggleMaximize" | "close" | "startDragging";

interface WindowControlsState {
  maximized: boolean;
  run: (action: WindowAction) => Promise<void>;
}

export function useWindowControls(): WindowControlsState {
  const [maximized, setMaximized] = useState(false);
  const run = useCallback(async (action: WindowAction) => {
    if (!isTauri()) {
      console.debug(`[window-controls] ${action} unavailable outside Tauri`);
      return;
    }
    try {
      console.debug(`[window-controls] ${action}`);
      const currentWindow = getCurrentWindow();
      await currentWindow[action]();
      if (action === "toggleMaximize") setMaximized(await currentWindow.isMaximized());
    } catch (error) {
      console.error(`[window-controls] ${action} failed`, error);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const currentWindow = getCurrentWindow();
    const update = async () => {
      try {
        const value = await currentWindow.isMaximized();
        if (!disposed) setMaximized(value);
      } catch (error) {
        console.error("[window-controls] reading maximized state failed", error);
      }
    };
    void update();
    void currentWindow
      .onResized(() => void update())
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => console.error("[window-controls] resize listener failed", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { maximized, run };
}
