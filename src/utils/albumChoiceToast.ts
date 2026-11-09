import type { ToastRequest } from "../toasts/toastRequest";

interface AlbumChoiceLike {
  albumId?: string;
  newAlbumName?: string;
}

interface NamedAlbum {
  id: string;
  albumName: string;
}

/** Success toast for a finished "add to album" or "new album" choice; null when nothing was chosen. */
export function albumChoiceToast(
  choice: AlbumChoiceLike,
  count: number,
  albums: readonly NamedAlbum[],
): ToastRequest | null {
  if (choice.albumId) {
    const name = albums.find((album) => album.id === choice.albumId)?.albumName;
    return { kind: "success", key: "album.photosAdded", params: { count, name } };
  }
  if (choice.newAlbumName) {
    return {
      kind: "success",
      key: "album.createdWithPhotos",
      params: { count, name: choice.newAlbumName },
    };
  }
  return null;
}
