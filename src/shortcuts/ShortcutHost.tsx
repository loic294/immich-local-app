import { AlbumCreateModal } from "../components/Albums/AlbumCreateModal";
import type { AppPage } from "../components/Layout/Sidebar";
import { useAlbumCreate } from "../hooks/useAlbumCreate";
import { useNavigationShortcuts } from "./useNavigationShortcuts";
import { useShortcutHandler } from "./useShortcutHandler";

interface ShortcutHostProps {
  onNavigate: (page: AppPage) => void;
}

function openAlbum(albumId: string, onNavigate: (page: AppPage) => void) {
  // Same hand-off as the sidebar's recent albums: a mounted Albums page hears the event, a page
  // that is not mounted yet picks the album up from session storage when it mounts.
  sessionStorage.setItem("immich:open-recent-album", albumId);
  window.dispatchEvent(new CustomEvent("immich:open-album", { detail: albumId }));
  onNavigate("albums");
}

/**
 * Hosts the app-wide shortcut actions that are not tied to a single view: switching pages and
 * creating an album. Mounted once while signed in, so the native menu can always reach them.
 */
export function ShortcutHost({ onNavigate }: ShortcutHostProps) {
  const albumCreate = useAlbumCreate({
    onCreated: (albumId) => openAlbum(albumId, onNavigate),
  });

  useNavigationShortcuts(onNavigate);
  useShortcutHandler("album.create", albumCreate.open, { scope: "global" });

  if (!albumCreate.isOpen) {
    return null;
  }
  return (
    <AlbumCreateModal
      online={albumCreate.online}
      busy={albumCreate.busy}
      error={albumCreate.error}
      onSubmit={(albumName) => void albumCreate.create(albumName)}
      onClose={albumCreate.close}
    />
  );
}
