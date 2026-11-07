import { useAlbumManagement } from "../../hooks/useAlbumManagement";
import type { AlbumOwnerAccess, AlbumSummary } from "../../types";
import { AlbumAccessModal } from "./AlbumAccessModal";
import { AlbumActionsMenu } from "./AlbumActionsMenu";
import { AlbumDeleteConfirmDialog } from "./AlbumDeleteConfirmDialog";
import { AlbumRenameModal } from "./AlbumRenameModal";

interface AlbumActionsProps {
  album: AlbumSummary;
  access: AlbumOwnerAccess;
  onDeleted: (albumId: string) => void;
}

/** Three-dot menu with the Rename, Manage access and Delete album actions, owner-only. */
export function AlbumActions({ album, access, onDeleted }: AlbumActionsProps) {
  const management = useAlbumManagement(album, onDeleted);

  return (
    <>
      <AlbumActionsMenu
        online={management.online}
        access={access}
        onRename={() => management.openDialog("rename")}
        onManageAccess={() => management.openDialog("access")}
        onDelete={() => management.openDialog("delete")}
      />
      {management.dialog === "access" ? (
        <AlbumAccessModal
          albumId={album.id}
          albumName={album.albumName}
          ownerId={album.ownerId}
          owner={album.owner}
          onClose={management.closeDialog}
        />
      ) : null}
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
