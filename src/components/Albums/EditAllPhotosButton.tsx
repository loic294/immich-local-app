import { useRef, useState } from "react";
import { Pencil, LoaderCircle } from "lucide-react";
import { requestMediaEdit } from "../../api/media";
import { getCachedAlbumAssetsPaged } from "../../api/tauri";
import { useMediaLabels } from "../../i18n/media";

const PAGE_SIZE = 500;
const MAX_PAGES = 1000;

/** Collects every cached (unfiltered) photo of the album, excluding videos. */
async function collectAlbumPhotoIds(albumId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await getCachedAlbumAssetsPaged(albumId, page, PAGE_SIZE, null, null);
    for (const asset of result.items) {
      if ((asset.type ?? "").toUpperCase() !== "VIDEO") ids.push(asset.id);
    }
    if (!result.hasNextPage) break;
  }
  return ids;
}

type EditAllPhotosButtonProps = { albumId: string };

/** Album toolbar action that opens every cached album photo in the external editor. */
export function EditAllPhotosButton({ albumId }: EditAllPhotosButtonProps) {
  const labels = useMediaLabels();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const ids = await collectAlbumPhotoIds(albumId);
      console.info(`[albums.editAll] album=${albumId} photos=${ids.length}`);
      if (ids.length > 0) requestMediaEdit(ids, albumId);
    } catch (cause) {
      console.error(`[albums.editAll] failed album=${albumId}`, cause);
      setError(String(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="btn btn-sm btn-outline shrink-0"
      disabled={busy}
      title={error ?? labels.editAll}
      onClick={() => void run()}
    >
      {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Pencil size={16} />}
      {labels.editAll}
      {error ? <span className="badge badge-error badge-xs">!</span> : null}
    </button>
  );
}
