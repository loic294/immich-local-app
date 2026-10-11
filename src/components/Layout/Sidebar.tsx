import {
  Archive,
  CalendarDays,
  FolderTree,
  Heart,
  Image,
  Images,
  Map,
  Settings,
  UsersRound,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { requestMediaImport } from "../../api/media";
import { useMediaLabels } from "../../i18n/media";
import { SyncStatusCard } from "./SyncStatusCard";
import { RecentAlbumsSection } from "../Albums/RecentAlbumsSection";
import { OfflineBanner } from "./OfflineBanner";
import { useConnectionContext } from "../../hooks/connectionContext";
import { useSettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import logoUrl from "../../assets/logo_with_title.svg";
import { useBrowsingI18n } from "../../i18n/browsing";

interface SidebarProps {
  activePage: AppPage;
  onNavigate?: (page: AppPage) => void;
}

export type AppPage =
  | "photos"
  | "favorites"
  | "deleted"
  | "albums"
  | "people"
  | "maps"
  | "folders"
  | "calendar"
  | "settings";

/** Navigation menu item that can be toggled via Settings. */
export type MenuItemKey =
  | "photos"
  | "albums"
  | "people"
  | "maps"
  | "calendar"
  | "folders"
  | "favorites"
  | "deleted";

type MenuItemDef = {
  key: MenuItemKey;
  labelKey: string;
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
  { key: "photos", labelKey: "nav.photos", icon: Image, group: "main" },
  { key: "albums", labelKey: "nav.albums", icon: Images, group: "main" },
  { key: "people", labelKey: "nav.people", icon: UsersRound, group: "library" },
  { key: "maps", labelKey: "nav.maps", icon: Map, group: "library" },
  {
    key: "calendar",
    labelKey: "nav.calendar",
    icon: CalendarDays,
    group: "main",
  },
  { key: "folders", labelKey: "nav.folders", icon: FolderTree, group: "main" },
  {
    key: "favorites",
    labelKey: "nav.favorites",
    icon: Heart,
    group: "library",
  },
  { key: "deleted", labelKey: "nav.deleted", icon: Archive, group: "library" },
];

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { t } = useI18n();
  const mediaLabels = useMediaLabels();
  const bt = useBrowsingI18n();
  const { isOnline, pendingCount } = useConnectionContext();
  const settingsQuery = useSettings();
  // Until settings load, show every item so navigation is never empty.
  const savedItems = settingsQuery.data?.menuItems;
  const orderedItems = savedItems
    ? savedItems.flatMap((preference) => {
        const item = MENU_ITEMS.find((candidate) => candidate.key === preference.key);
        return item ? [{ ...item, group: preference.group }] : [];
      })
    : MENU_ITEMS;
  const mainItems = orderedItems.filter((item) => item.group === "main");
  const libraryItems = orderedItems.filter((item) => item.group === "library");

  const openRecentAlbum = (albumId: string) => {
    sessionStorage.setItem("immich:open-recent-album", albumId);
    window.dispatchEvent(new CustomEvent("immich:open-album", { detail: albumId }));
    onNavigate?.("albums");
  };

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
              {mainItems.map(({ key, labelKey, icon: Icon }) => (
                <button
                  key={key}
                  className={navClass(key)}
                  type="button"
                  onClick={() => onNavigate?.(key)}
                >
                  <Icon size={16} className="shrink-0" />
                  <span>{key === "people" || key === "maps" ? bt(key) : t(labelKey)}</span>
                </button>
              ))}
            </nav>
          ) : null}

          <RecentAlbumsSection
            limit={settingsQuery.data?.recentAlbumsLimit ?? 5}
            onOpenAlbum={openRecentAlbum}
          />

          {libraryItems.length > 0 ? (
            <>
              <div className="mt-3 w-full px-2 text-sm font-semibold uppercase tracking-wide text-base-content/50">
                {t("nav.library")}
              </div>
              <nav className="menu menu-vertical w-full rounded-box bg-base-100 p-1">
                {libraryItems.map(({ key, labelKey, icon: Icon }) => (
                  <button
                    key={key}
                    className={navClass(key)}
                    type="button"
                    onClick={() => onNavigate?.(key)}
                  >
                    <Icon size={16} className="shrink-0" />
                    <span>{key === "people" || key === "maps" ? bt(key) : t(labelKey)}</span>
                  </button>
                ))}
              </nav>
            </>
          ) : null}
        </div>

        <div className="shrink-0 w-full space-y-3 px-2 pb-2">
          <nav className="menu menu-vertical w-full rounded-box bg-base-100 p-1">
            <button
              className="btn btn-md btn-block w-full max-w-none btn-ghost justify-start text-base font-semibold"
              type="button"
              onClick={requestMediaImport}
            >
              <Upload size={16} className="shrink-0" />
              <span>{mediaLabels.import}</span>
            </button>
            <button
              className={navClass("settings")}
              type="button"
              onClick={() => onNavigate?.("settings")}
            >
              <Settings size={16} className="shrink-0" />
              <span>{t("nav.settings")}</span>
            </button>
          </nav>
          {isOnline === false ? <OfflineBanner pendingCount={pendingCount} /> : <SyncStatusCard />}
        </div>
      </div>
    </aside>
  );
}
