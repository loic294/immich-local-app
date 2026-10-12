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
import { isMacPlatform } from "../../utils/platform";
import { useBrowsingI18n } from "../../i18n/browsing";
import { SidebarButton } from "./SidebarButton";
import { useRecentAlbums } from "../../hooks/useRecentAlbums";
import type { AlbumSummary } from "../../types";

const EMPTY_RECENT_ALBUMS: AlbumSummary[] = [];

interface SidebarProps {
  activePage: AppPage;
  activeAlbumId?: string | null;
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

export function Sidebar({ activePage, activeAlbumId = null, onNavigate }: SidebarProps) {
  const { t } = useI18n();
  const mediaLabels = useMediaLabels();
  const bt = useBrowsingI18n();
  const { isOnline, pendingCount } = useConnectionContext();
  const settingsQuery = useSettings();
  // Until settings load, show every item so navigation is never empty.
  const savedItems = settingsQuery.data?.menuItems;
  const recentAlbumsLimit = settingsQuery.data?.recentAlbumsLimit ?? 5;
  const recentAlbumsQuery = useRecentAlbums(recentAlbumsLimit);
  const recentAlbums =
    recentAlbumsLimit > 0 ? (recentAlbumsQuery.data ?? EMPTY_RECENT_ALBUMS) : EMPTY_RECENT_ALBUMS;
  const hasActiveRecentAlbum =
    activePage === "albums" && recentAlbums.some((album) => album.id === activeAlbumId);
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

  const isPageActive = (page: AppPage) =>
    page === activePage && (page !== "albums" || !hasActiveRecentAlbum);

  const mac = isMacPlatform();

  return (
    <aside className="hidden h-screen min-w-0 overflow-y-auto border-r border-base-300 bg-base-100 lg:sticky lg:top-0 lg:flex">
      <div className="flex h-full min-h-0 min-w-0 w-full flex-col gap-6 p-3">
        <div
          data-tauri-drag-region
          className={`flex h-10 items-center gap-2 text-3xl font-bold text-primary ${mac ? "pl-[78px] pr-2" : "px-2"}`}
        >
          <img src={logoUrl} alt="" className={`pointer-events-none ${mac ? "h-8" : "h-10"}`} />
        </div>

        <div className="flex min-h-0 flex-1 w-full flex-col gap-6 overflow-y-auto pr-1">
          {mainItems.length > 0 ? (
            <nav className="menu menu-vertical w-full shrink-0 rounded-box bg-base-100 p-1">
              {mainItems.map(({ key, labelKey, icon: Icon }) => (
                <SidebarButton
                  key={key}
                  isActive={isPageActive(key)}
                  leading={<Icon size={16} />}
                  label={key === "people" || key === "maps" ? bt(key) : t(labelKey)}
                  onClick={() => onNavigate?.(key)}
                />
              ))}
            </nav>
          ) : null}

          <RecentAlbumsSection
            albums={recentAlbums}
            activeAlbumId={activePage === "albums" ? activeAlbumId : null}
            onOpenAlbum={openRecentAlbum}
          />

          {libraryItems.length > 0 ? (
            <section className="shrink-0 space-y-1" aria-label={t("nav.library")}>
              <h2 className="w-full px-3 text-xs font-semibold uppercase tracking-wide text-base-content/50">
                {t("nav.library")}
              </h2>
              <nav className="menu menu-vertical w-full rounded-box bg-base-100 p-1">
                {libraryItems.map(({ key, labelKey, icon: Icon }) => (
                  <SidebarButton
                    key={key}
                    isActive={isPageActive(key)}
                    leading={<Icon size={16} />}
                    label={key === "people" || key === "maps" ? bt(key) : t(labelKey)}
                    onClick={() => onNavigate?.(key)}
                  />
                ))}
              </nav>
            </section>
          ) : null}
        </div>

        <div className="shrink-0 w-full space-y-6 pb-2">
          <nav className="menu menu-vertical w-full rounded-box bg-base-100 p-1">
            <SidebarButton
              leading={<Upload size={16} />}
              label={mediaLabels.import}
              onClick={requestMediaImport}
            />
            <SidebarButton
              isActive={isPageActive("settings")}
              leading={<Settings size={16} />}
              label={t("nav.settings")}
              onClick={() => onNavigate?.("settings")}
            />
          </nav>
          <div className="px-2">
            {isOnline === false ? (
              <OfflineBanner pendingCount={pendingCount} />
            ) : (
              <SyncStatusCard />
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
