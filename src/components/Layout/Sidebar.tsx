import {
  Archive,
  CalendarDays,
  FolderTree,
  Heart,
  Image,
  Images,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { SyncStatusCard } from "./SyncStatusCard";
import { OfflineBanner } from "./OfflineBanner";
import { useConnectionContext } from "../../hooks/connectionContext";
import { useSettings } from "../../hooks/useSettings";
import logoUrl from "../../assets/logo_with_title.svg";

interface SidebarProps {
  activePage: AppPage;
  onNavigate?: (page: AppPage) => void;
}

export type AppPage =
  | "photos"
  | "favorites"
  | "deleted"
  | "albums"
  | "folders"
  | "calendar"
  | "settings";

/** Navigation menu item that can be toggled via Settings. */
export type MenuItemKey =
  | "photos"
  | "albums"
  | "calendar"
  | "folders"
  | "favorites"
  | "deleted";

type MenuItemDef = {
  key: MenuItemKey;
  label: string;
  icon: LucideIcon;
  /** "main" items sit in the top group; "library" in the second group. */
  group: "main" | "library";
};

/**
 * Ordered, shared definition of the toggleable navigation items. Keep the keys
 * in sync with the backend `default_menu_items()` list. `settings` is always
 * shown (it lives in the footer) and is intentionally not part of this list.
 */
export const MENU_ITEMS: MenuItemDef[] = [
  { key: "photos", label: "Photos", icon: Image, group: "main" },
  { key: "albums", label: "Albums", icon: Images, group: "main" },
  { key: "calendar", label: "Calendar", icon: CalendarDays, group: "main" },
  { key: "folders", label: "Folders", icon: FolderTree, group: "main" },
  { key: "favorites", label: "Favorites", icon: Heart, group: "library" },
  { key: "deleted", label: "Deleted", icon: Archive, group: "library" },
];

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { isOnline, pendingCount } = useConnectionContext();
  const settingsQuery = useSettings();
  // Until settings load, show every item so navigation is never empty.
  const visibleKeys = settingsQuery.data?.menuItems;
  const isVisible = (key: MenuItemKey) =>
    visibleKeys ? visibleKeys.includes(key) : true;

  const mainItems = MENU_ITEMS.filter(
    (item) => item.group === "main" && isVisible(item.key),
  );
  const libraryItems = MENU_ITEMS.filter(
    (item) => item.group === "library" && isVisible(item.key),
  );

  const navClass = (page: AppPage) =>
    page === activePage
      ? "btn btn-md btn-block w-full max-w-none btn-soft btn-primary justify-start text-base font-semibold"
      : "btn btn-md btn-block w-full max-w-none btn-ghost justify-start text-base font-semibold";

  return (
    <aside className="hidden h-screen border-r border-base-300 bg-base-100 lg:sticky lg:top-0 lg:flex">
      <div className="flex h-full min-h-0 w-full flex-col gap-3 p-3">
        <div className="flex h-10 items-center gap-2 px-2 text-3xl font-bold text-primary">
          <img src={logoUrl} alt="" className="h-10" />
        </div>

        <div className="min-h-0 flex-1 w-full overflow-y-auto pr-1">
          {mainItems.length > 0 ? (
            <nav className="menu menu-vertical w-full rounded-box bg-base-100 p-1">
              {mainItems.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  className={navClass(key)}
                  type="button"
                  onClick={() => onNavigate?.(key)}
                >
                  <Icon size={16} className="shrink-0" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          ) : null}

          {libraryItems.length > 0 ? (
            <>
              <div className="mt-3 w-full px-2 text-sm font-semibold uppercase tracking-wide text-base-content/50">
                Library
              </div>
              <nav className="menu menu-vertical w-full rounded-box bg-base-100 p-1">
                {libraryItems.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    className={navClass(key)}
                    type="button"
                    onClick={() => onNavigate?.(key)}
                  >
                    <Icon size={16} className="shrink-0" />
                    <span>{label}</span>
                  </button>
                ))}
              </nav>
            </>
          ) : null}
        </div>

        <div className="shrink-0 w-full space-y-3 px-2 pb-2">
          <nav className="menu menu-vertical w-full rounded-box bg-base-100 p-1">
            <button
              className={navClass("settings")}
              type="button"
              onClick={() => onNavigate?.("settings")}
            >
              <Settings size={16} className="shrink-0" />
              <span>Settings</span>
            </button>
          </nav>
          {isOnline === false ? (
            <OfflineBanner pendingCount={pendingCount} />
          ) : (
            <SyncStatusCard />
          )}
        </div>
      </div>
    </aside>
  );
}
