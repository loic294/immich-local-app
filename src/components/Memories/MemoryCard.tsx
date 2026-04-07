import { useEffect, useState } from "react";
import { Camera } from "lucide-react";
import { getAssetThumbnail } from "../../api/tauri";

interface MemoryCardProps {
  assetId: string;
  label: string;
  name: string;
  isActive: boolean;
  onClick: () => void;
}

export function MemoryCard({
  assetId,
  label,
  name,
  isActive,
  onClick,
}: MemoryCardProps) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const value = await getAssetThumbnail(assetId);
        if (!cancelled) {
          setSrc(value);
        }
      } catch {
        if (!cancelled) {
          setSrc(null);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  return (
    <button
      type="button"
      className={`relative aspect-[2.4/1] overflow-hidden rounded-lg border bg-base-300 text-left transition ${
        isActive
          ? "border-primary ring-2 ring-primary/60"
          : "border-transparent hover:border-base-300"
      }`}
      aria-label={name}
      onClick={onClick}
    >
      {src ? (
        <img alt={name} src={src} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-base-content/60">
          <Camera size={18} />
        </div>
      )}
      <p className="absolute bottom-2 left-2 m-0 text-lg font-semibold text-white drop-shadow">
        {label}
      </p>
    </button>
  );
}
