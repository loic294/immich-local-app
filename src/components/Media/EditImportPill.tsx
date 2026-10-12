import { useSyncExternalStore } from "react";
import { getMediaEditState, subscribeMediaEditState } from "../../api/media";
import { useMediaLabels } from "../../i18n/media";

interface EditImportPillProps {
  originalId: string;
}

export function EditImportPill({ originalId }: EditImportPillProps) {
  const labels = useMediaLabels();
  const state = useSyncExternalStore(subscribeMediaEditState, getMediaEditState);
  const importing = state.imports[originalId];
  if (!importing) return null;

  return (
    <div
      role={importing.state === "failed" ? "alert" : "status"}
      className="pointer-events-auto absolute bottom-2 left-1/2 z-30 flex w-max max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2 rounded-full bg-base-100 px-3 py-1.5 text-xs text-base-content shadow-lg"
      title={importing.error ?? labels.importingEdit}
    >
      {importing.state === "failed" ? (
        <button
          type="button"
          className="min-w-0 truncate text-error"
          onClick={() => window.dispatchEvent(new Event("media:show-upload-queue"))}
        >
          {labels.failed}: {importing.error}
        </button>
      ) : (
        <>
          <span className="loading loading-spinner loading-xs shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words text-center leading-tight">
            {labels.importingEdit}
          </span>
        </>
      )}
    </div>
  );
}
