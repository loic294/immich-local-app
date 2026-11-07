import { useEffect, useRef } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useAlbumManagementLabels } from "../../i18n/albumManagement";

interface AlbumActionsMenuProps {
  online: boolean;
  onRename: () => void;
  onDelete: () => void;
}

export function AlbumActionsMenu({ online, onRename, onDelete }: AlbumActionsMenuProps) {
  const labels = useAlbumManagementLabels();
  const menuRef = useRef<HTMLDetailsElement>(null);

  const closeMenu = () => {
    if (menuRef.current) menuRef.current.open = false;
  };

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  return (
    <details
      ref={menuRef}
      className="dropdown dropdown-end shrink-0"
      onMouseDown={(event) => {
        // Keep WebKit from dismissing the menu before the button's click.
        if (
          event.button === 0 &&
          event.target instanceof Element &&
          event.target.closest("button")
        ) {
          event.preventDefault();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeMenu();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuRef.current?.open) {
          event.stopPropagation();
          closeMenu();
          menuRef.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary
        className="btn btn-sm btn-square btn-ghost list-none"
        aria-label={labels.actionsAria}
        title={labels.actionsAria}
      >
        <MoreHorizontal size={16} />
      </summary>
      <ul className="menu dropdown-content z-[130] mt-2 w-60 rounded-box border border-base-300 bg-base-100 p-1 shadow">
        {!online ? <li className="menu-title normal-case">{labels.offlineHint}</li> : null}
        <li>
          <button
            type="button"
            disabled={!online}
            onClick={() => {
              closeMenu();
              onRename();
            }}
          >
            <Pencil size={14} />
            {labels.rename}
          </button>
        </li>
        <li>
          <button
            type="button"
            className="text-error"
            disabled={!online}
            onClick={() => {
              closeMenu();
              onDelete();
            }}
          >
            <Trash2 size={14} />
            {labels.delete}
          </button>
        </li>
      </ul>
    </details>
  );
}
