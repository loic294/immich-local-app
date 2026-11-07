import { useEffect, useRef } from "react";
import { MoreHorizontal, Pencil, Trash2, Users } from "lucide-react";
import { useAlbumManagementLabels } from "../../i18n/albumManagement";
import type { AlbumOwnerAccess } from "../../types";

interface AlbumActionsMenuProps {
  online: boolean;
  access: AlbumOwnerAccess;
  onRename: () => void;
  onManageAccess: () => void;
  onDelete: () => void;
}

type MenuLabels = ReturnType<typeof useAlbumManagementLabels>;

/** Why the actions are greyed out, or null when they are available. */
function unavailableHint(online: boolean, access: AlbumOwnerAccess, labels: MenuLabels) {
  if (!online) return labels.offlineHint;
  if (access === "checking") return labels.checkingHint;
  if (access === "not-owner") return labels.notOwnerHint;
  return null;
}

/** Always shown; every action needs the owner's server, so they grey out otherwise. */
export function AlbumActionsMenu({
  online,
  access,
  onRename,
  onManageAccess,
  onDelete,
}: AlbumActionsMenuProps) {
  const labels = useAlbumManagementLabels();
  const menuRef = useRef<HTMLDetailsElement>(null);
  const enabled = online && access === "owner";
  const hint = unavailableHint(online, access, labels);
  const itemClass = enabled ? undefined : "menu-disabled";

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
      <ul className="menu dropdown-content z-[130] mt-2 w-64 rounded-box border border-base-300 bg-base-100 p-1 shadow">
        {hint ? <li className="menu-title normal-case">{hint}</li> : null}
        <li className={itemClass}>
          <button
            type="button"
            disabled={!enabled}
            onClick={() => {
              closeMenu();
              onRename();
            }}
          >
            <Pencil size={14} />
            {labels.rename}
          </button>
        </li>
        <li className={itemClass}>
          <button
            type="button"
            disabled={!enabled}
            onClick={() => {
              closeMenu();
              onManageAccess();
            }}
          >
            <Users size={14} />
            {labels.manageAccess}
          </button>
        </li>
        <li className={itemClass}>
          <button
            type="button"
            className={enabled ? "text-error" : undefined}
            disabled={!enabled}
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
