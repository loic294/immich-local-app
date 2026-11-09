import { useRef } from "react";
import { useI18n } from "../../i18n";
import { useDockInset } from "../../toasts/dockInset";

interface LocalFileApplyProgressProps {
  done: number;
  total: number;
}

/** Bottom-right progress panel shown while saved local file changes are applied. */
export function LocalFileApplyProgress({ done, total }: LocalFileApplyProgressProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  useDockInset(panelRef);

  return (
    <div
      ref={panelRef}
      className="fixed bottom-4 right-4 z-50 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg"
    >
      <p className="text-xs font-medium text-base-content mb-2">
        {t("localChanges.applyingOverlay")}
      </p>
      <progress
        className="progress progress-primary progress-sm w-full"
        value={done}
        max={Math.max(total, 1)}
      ></progress>
      <p className="mt-1 text-[11px] text-base-content/70">
        {done} / {total}
      </p>
    </div>
  );
}
