import { useQuery } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Image, Film } from "lucide-react";
import { getImportPreview, type ImportFile } from "../../api/media";
import { useMediaLabels } from "../../i18n/media";

interface ImportTileProps {
  file: ImportFile;
  checked: boolean;
  onToggle: () => void;
}
export function ImportTile({ file, checked, onToggle }: ImportTileProps) {
  const labels = useMediaLabels();
  const preview = useQuery({
    queryKey: ["import-preview", file.path, file.checksum],
    queryFn: () => getImportPreview(file.path),
    staleTime: Infinity,
    retry: false,
    gcTime: 30_000,
  });
  return (
    <label
      className={`relative flex cursor-pointer flex-col overflow-hidden rounded-box border ${checked ? "border-primary" : "border-base-300"} ${file.alreadyImported ? "opacity-50" : ""}`}
    >
      <div className="aspect-square overflow-hidden bg-base-300">
        {preview.data ? (
          file.kind === "video" ? (
            <video
              className="h-full w-full object-cover"
              src={convertFileSrc(preview.data)}
              muted
              preload="metadata"
            />
          ) : (
            <img className="h-full w-full object-cover" src={preview.data} alt="" loading="lazy" />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-base-content/60">
            {file.kind === "video" ? <Film /> : <Image />}
            {preview.isError && (
              <span className="text-xs" title={String(preview.error)}>
                {labels.preview}
              </span>
            )}
          </div>
        )}
      </div>
      <input
        type="checkbox"
        className="checkbox checkbox-primary absolute left-2 top-2"
        checked={checked}
        disabled={file.alreadyImported}
        onChange={onToggle}
        aria-label={file.name}
      />
      <span className="truncate p-2 text-xs" title={file.name}>
        {file.name}
      </span>
      {file.alreadyImported && <span className="px-2 pb-2 text-xs">{labels.duplicate}</span>}
    </label>
  );
}
