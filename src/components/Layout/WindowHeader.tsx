import type { ReactNode } from "react";
import { isMacWindow, useWindowControls } from "../../hooks/useWindowControls";
import { WindowControls } from "./WindowControls";

interface WindowHeaderProps {
  children?: ReactNode;
  floating?: boolean;
}

export function WindowHeader({ children, floating = false }: WindowHeaderProps) {
  const { run } = useWindowControls();
  const mac = isMacWindow();
  return (
    <header
      className={`navbar min-h-16 gap-3 border-b border-base-300 bg-base-100 pl-3 sm:pl-4 ${floating ? "fixed inset-x-0 top-0 z-50" : ""} ${mac ? "pr-3 sm:pr-4" : "pr-0"}`}
    >
      {mac && <WindowControls />}
      {children}
      <div
        className="h-12 min-w-6 flex-1 self-stretch"
        data-tauri-drag-region
        onMouseDown={(event) => {
          // Own the gesture so Tauri's document handler cannot toggle twice.
          event.stopPropagation();
          if (event.button === 0) void run(event.detail === 2 ? "toggleMaximize" : "startDragging");
        }}
      />
      {!mac && (
        <div className="order-3 self-stretch flex">
          <WindowControls />
        </div>
      )}
    </header>
  );
}
