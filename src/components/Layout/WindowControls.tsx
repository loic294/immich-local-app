import { Minus, Square, Copy, X, Maximize2, Minimize2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { isMacWindow, useWindowControls } from "../../hooks/useWindowControls";

export function WindowControls() {
  const { t } = useI18n();
  const { maximized, run } = useWindowControls();
  const mac = isMacWindow();
  const controls = {
    minimize: {
      label: t("window.minimize"),
      action: "minimize",
      icon: Minus,
      color: "bg-warning text-warning-content",
    },
    maximize: {
      label: t(maximized ? "window.restore" : "window.maximize"),
      action: "toggleMaximize",
      icon: mac ? (maximized ? Minimize2 : Maximize2) : maximized ? Copy : Square,
      color: "bg-success text-success-content",
    },
    close: {
      label: t("window.close"),
      action: "close",
      icon: X,
      color: "bg-error text-error-content",
    },
  } as const;
  return (
    <div
      className={`group flex shrink-0 items-center ${mac ? "gap-2 px-1" : "gap-0 self-stretch"}`}
      data-window-controls={mac ? "macos" : "windows"}
    >
      {(mac
        ? [controls.close, controls.minimize, controls.maximize]
        : [controls.minimize, controls.maximize, controls.close]
      ).map(({ label, action, icon: Icon, color }) => (
        <button
          key={action}
          type="button"
          aria-label={label}
          title={label}
          className={
            mac
              ? `btn btn-circle btn-xs h-4 min-h-4 w-4 border-0 p-0 ${color}`
              : `btn btn-ghost h-full min-h-10 w-11 rounded-none p-0 ${action === "close" ? "hover:bg-error hover:text-error-content" : ""}`
          }
          onClick={() => void run(action)}
        >
          <Icon
            size={mac ? 10 : 14}
            aria-hidden="true"
            className={
              mac ? "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" : ""
            }
          />
        </button>
      ))}
    </div>
  );
}
