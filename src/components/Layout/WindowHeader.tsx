import type { ReactNode } from "react";
import { useWindowFullscreen } from "../../hooks/useWindowFullscreen";
import { isMacPlatform } from "../../utils/platform";

interface WindowHeaderProps {
  children?: ReactNode;
  floating?: boolean;
  flushEnd?: boolean;
}

/**
 * On macOS the native title bar is an overlay: the real traffic lights sit on
 * top of the sidebar (or this header when the sidebar is hidden), so reserve
 * space for them and expose a drag region outside native fullscreen.
 * Other platforms keep their standard native title bar.
 */
export function WindowHeader({ children, floating = false, flushEnd = false }: WindowHeaderProps) {
  const mac = isMacPlatform();
  const isWindowFullscreen = useWindowFullscreen();
  const reserveTrafficLights = mac && !isWindowFullscreen;
  if (floating) {
    return reserveTrafficLights ? (
      <div aria-hidden data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 h-12" />
    ) : null;
  }
  return (
    <header
      data-tauri-drag-region
      className="navbar min-h-16 gap-3 border-b border-base-300 bg-base-100 px-3 sm:px-4"
    >
      {reserveTrafficLights && (
        <div aria-hidden className="w-16 shrink-0 self-stretch lg:hidden" data-tauri-drag-region />
      )}
      {children}
      {!flushEnd ? (
        <div className="h-12 min-w-6 flex-1 self-stretch" data-tauri-drag-region />
      ) : null}
    </header>
  );
}
