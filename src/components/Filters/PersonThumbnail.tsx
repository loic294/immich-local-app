import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { getPersonThumbnail } from "../../api/tauri";

interface PersonThumbnailProps {
  personId: string;
  name: string | null;
  size?: number;
}

/**
 * A person's face thumbnail, loaded lazily from the local-first cache. Falls
 * back to a neutral avatar placeholder while loading or when no face is
 * available (e.g. while offline before the face has been cached).
 */
export function PersonThumbnail({
  personId,
  name,
  size = 24,
}: PersonThumbnailProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setFailed(false);

    getPersonThumbnail(personId)
      .then((url) => {
        if (!cancelled) {
          setDataUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [personId]);

  const dimension = { width: size, height: size };

  if (dataUrl && !failed) {
    return (
      <img
        src={dataUrl}
        alt={name ?? "Person"}
        className="rounded-full object-cover shrink-0"
        style={dimension}
      />
    );
  }

  return (
    <span
      className="flex items-center justify-center rounded-full bg-base-300 text-base-content/60 shrink-0"
      style={dimension}
      aria-hidden="true"
    >
      <User size={Math.round(size * 0.6)} />
    </span>
  );
}
