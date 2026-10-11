import type { ReactNode } from "react";
import { isMacPlatform } from "../../utils/platform";

interface WindowHeaderProps {
  children?: ReactNode;
  floating?: boolean;
}

/**
 * On macOS the native title bar is an overlay: the real traffic lights sit on
 * top of the sidebar (or this header when the sidebar is hidden), so reserve
 * space for them and expose a drag region.
 * Other platforms keep their standard native title bar.
 */
export function WindowHeader({ children, floating = false }: WindowHeaderProps) {
  const mac = isMacPlatform();
  if (floating) {
    return mac ? (
      <div aria-hidden data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 h-12" />
    ) : null;
  }
  return (
    <header
      data-tauri-drag-region
      className="navbar min-h-16 gap-3 border-b border-base-300 bg-base-100 px-3 sm:px-4"
    >
      {mac && (
        <div aria-hidden className="w-16 shrink-0 self-stretch lg:hidden" data-tauri-drag-region />
      )}
      {children}
      <div className="h-12 min-w-6 flex-1 self-stretch" data-tauri-drag-region />
    </header>
  );
}
