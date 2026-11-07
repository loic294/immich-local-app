import { useAlbumManagement } from "../../hooks/useAlbumManagement";
import type { AlbumSummary } from "../../types";
import { AlbumActionsMenu } from "./AlbumActionsMenu";
import { AlbumDeleteConfirmDialog } from "./AlbumDeleteConfirmDialog";
import { AlbumRenameModal } from "./AlbumRenameModal";

interface AlbumActionsProps {
  album: AlbumSummary;
  onDeleted: (albumId: string) => void;
}

/** Three-dot menu with the owner-only Rename and Delete album actions. */
export function AlbumActions({ album, onDeleted }: AlbumActionsProps) {
  const management = useAlbumManagement(album, onDeleted);

  return (
    <>
      <AlbumActionsMenu
        online={management.online}
        onRename={() => management.openDialog("rename")}
        onDelete={() => management.openDialog("delete")}
      />
      {management.dialog === "rename" ? (
        <AlbumRenameModal
          currentName={album.albumName}
          online={management.online}
          busy={management.busy}
          error={management.error}
          onSubmit={(albumName) => void management.rename(albumName)}
          onClose={management.closeDialog}
        />
      ) : null}
      {management.dialog === "delete" ? (
        <AlbumDeleteConfirmDialog
          albumName={album.albumName}
          shared={album.shared}
          online={management.online}
          busy={management.busy}
          error={management.error}
          onConfirm={() => void management.remove()}
          onClose={management.closeDialog}
        />
      ) : null}
    </>
  );
}
