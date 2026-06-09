import { X, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../../hooks/useSession";
import type { AlbumSummary } from "../../types";
import { Header } from "./Header";
import { SelectionActions } from "./SelectionActions";

interface AppTopBarProps {
  session: Session;
  onLogout: () => void;
  searchInput: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  selectedAssetIds?: string[];
  selectedCount?: number;
  onClearSelection?: () => void;
  onSelectAll?: () => void;
  fetchAlbumsForSelection?: () => Promise<AlbumSummary[]>;
  onAddSelectedToAlbum?: (input: {
    albumId?: string;
    newAlbumName?: string;
  }) => Promise<void>;
  onCreateShareLinkForSelected?: () => Promise<string>;
  onArchiveSelected?: () => Promise<void>;
}

export function AppTopBar({
  session,
  onLogout,
  searchInput,
  onSearchChange,
  searchPlaceholder,
  selectedAssetIds = [],
  selectedCount = 0,
  onClearSelection,
  onSelectAll,
  fetchAlbumsForSelection,
  onAddSelectedToAlbum,
  onCreateShareLinkForSelected,
  onArchiveSelected,
}: AppTopBarProps) {
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const canRunSelectionAction = selectedAssetIds.length > 0;

  useEffect(() => {
    if (selectedCount === 0) {
      setShowArchiveModal(false);
      setSelectionError(null);
    }
  }, [selectedCount]);

  const submitArchive = async () => {
    if (!onArchiveSelected || !canRunSelectionAction) {
      return;
    }

    setSelectionError(null);
    setIsArchiving(true);
    try {
      await onArchiveSelected();
      setShowArchiveModal(false);
      onClearSelection?.();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to archive photos";
      setSelectionError(message);
    } finally {
      setIsArchiving(false);
    }
  };

  if (selectedCount > 0) {
    return (
      <>
        <header className="navbar border-b border-base-300 bg-base-100 px-3 sm:px-4">
          <div className="navbar-start gap-4">
            <button
              type="button"
              className="btn btn-sm btn-outline gap-1"
              onClick={onClearSelection}
            >
              <X size={16} />
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-neutral"
              onClick={onSelectAll}
            >
              Select All
            </button>
            <p className="text-sm font-semibold text-base-content">
              {selectedCount} selected
            </p>
          </div>

          <div className="navbar-end gap-2">
            <SelectionActions
              selectedAssetIds={selectedAssetIds}
              selectedCount={selectedCount}
              fetchAlbumsForSelection={fetchAlbumsForSelection}
              onAddSelectedToAlbum={onAddSelectedToAlbum}
              onCreateShareLinkForSelected={onCreateShareLinkForSelected}
              onSelectionActionCompleted={onClearSelection}
            />
            <div className="h-5 w-px bg-base-300" />
            <button
              type="button"
              className="btn btn-sm btn-error"
              onClick={() => {
                setSelectionError(null);
                setShowArchiveModal(true);
              }}
            >
              <Trash2 size={16} />
              Delete
            </button>
          </div>
        </header>

        {showArchiveModal ? (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4">
            <div className="w-full max-w-md rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
              <h3 className="m-0 text-lg font-semibold">Archive photos?</h3>
              <p className="mb-4 mt-1 text-sm text-base-content/70">
                This will archive {selectedCount} selected photo
                {selectedCount > 1 ? "s" : ""}. You can restore them later.
              </p>

              {selectionError ? (
                <div className="alert alert-error mb-3 py-2 text-sm">
                  <span>{selectionError}</span>
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowArchiveModal(false)}
                  disabled={isArchiving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-error"
                  onClick={() => {
                    void submitArchive();
                  }}
                  disabled={isArchiving}
                >
                  {isArchiving ? "Archiving..." : "Archive"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <Header
      searchInput={searchInput}
      onSearchChange={onSearchChange}
      serverUrl={session.serverUrl}
      userId={session.userId}
      userName={session.userName}
      onLogout={onLogout}
      searchPlaceholder={searchPlaceholder}
    />
  );
}
