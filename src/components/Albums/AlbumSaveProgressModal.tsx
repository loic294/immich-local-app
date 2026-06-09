import { useEffect, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { LoaderCircle } from "lucide-react";

export interface AlbumSaveProgressData {
  totalAssets: number;
  copiedCount: number;
  currentFile: string | null;
  status: string;
}

interface AlbumSaveProgressModalProps {
  open: boolean;
  albumName: string;
}

export function AlbumSaveProgressModal({
  open,
  albumName,
}: AlbumSaveProgressModalProps) {
  const [progress, setProgress] = useState<AlbumSaveProgressData>({
    totalAssets: 0,
    copiedCount: 0,
    currentFile: null,
    status: "Starting download...",
  });

  useEffect(() => {
    if (!open) return;

    let unlisten: UnlistenFn | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<AlbumSaveProgressData>(
          "album_save_progress",
          (event) => {
            setProgress(event.payload);
          },
        );
      } catch (err) {
        console.error(
          "[album-save-progress] Failed to listen for progress:",
          err,
        );
      }
    };

    void setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [open]);

  if (!open) return null;

  const progressPercent =
    progress.totalAssets > 0
      ? Math.round((progress.copiedCount / progress.totalAssets) * 100)
      : 0;

  return (
    <dialog className="modal modal-open">
      <div className="modal-box w-96 max-w-md">
        <h2 className="text-lg font-bold mb-4">Saving Album</h2>

        <div className="space-y-4">
          <div>
            <p className="text-sm text-base-content/75 mb-2">{albumName}</p>
            <p className="text-sm font-medium mb-2">{progress.status}</p>
          </div>

          <div className="space-y-2">
            <div className="w-full bg-base-200 rounded-full h-3 overflow-hidden">
              <div
                className="bg-primary h-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-base-content/60">
              <span className="flex items-center gap-1">
                <LoaderCircle size={12} className="animate-spin" />
                {progress.copiedCount} / {progress.totalAssets} assets
              </span>
              <span>{progressPercent}%</span>
            </div>
          </div>

          {progress.currentFile ? (
            <div className="text-xs text-base-content/50 truncate">
              Copying: {progress.currentFile}
            </div>
          ) : null}
        </div>
      </div>
      <div className="modal-backdrop" />
    </dialog>
  );
}
