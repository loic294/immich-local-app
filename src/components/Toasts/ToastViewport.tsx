import { useToastLabels } from "../../i18n/toasts";
import { useTallestDockInset } from "../../toasts/dockInset";
import { computeToastViewportBottom } from "../../toasts/dockInsetStore";
import { dismissToast, pauseToast, resumeToast } from "../../toasts/toastStore";
import { useToasts } from "../../toasts/useToasts";
import { ToastCard } from "./ToastCard";

export function ToastViewport() {
  const toasts = useToasts();
  const labels = useToastLabels();
  const bottom = computeToastViewportBottom(useTallestDockInset());

  if (toasts.length === 0) return null;

  return (
    <section
      aria-label={labels.region}
      className="pointer-events-none fixed right-4 z-[10100] flex flex-col items-end gap-2 transition-[bottom] duration-200 motion-reduce:transition-none"
      style={{ bottom }}
    >
      {toasts.map((item) => (
        <ToastCard
          key={item.id}
          toast={item}
          message={labels.message(item)}
          dismissLabel={labels.dismiss}
          onDismiss={dismissToast}
          onPause={pauseToast}
          onResume={resumeToast}
        />
      ))}
    </section>
  );
}
