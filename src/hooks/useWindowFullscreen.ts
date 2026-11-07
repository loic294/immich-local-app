import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

/** Tracks native window fullscreen, not the in-app photo viewer. */
export function useWindowFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let requestId = 0;
    let lastFullscreen: boolean | undefined;
    let unlisten: (() => void) | undefined;

    const refresh = async () => {
      const currentRequest = ++requestId;
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (disposed || currentRequest !== requestId) return;
        if (fullscreen !== lastFullscreen) {
          console.info("[window-layout] native fullscreen changed", { fullscreen });
          lastFullscreen = fullscreen;
          setIsFullscreen(fullscreen);
        }
      } catch (error) {
        if (!disposed && currentRequest === requestId) {
          console.error("[window-layout] could not read native fullscreen state:", error);
        }
      }
    };

    const observe = async () => {
      try {
        const stop = await appWindow.onResized(() => void refresh());
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
      } catch (error) {
        if (disposed) return;
        console.error("[window-layout] could not listen for native window resizing:", error);
      }
      void refresh();
    };
    void observe();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return isFullscreen;
}
