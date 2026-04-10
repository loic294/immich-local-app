import {
  CalendarDays,
  FolderTree,
  Heart,
  Image,
  Images,
  Settings,
} from "lucide-react";
import { SyncStatusCard } from "./SyncStatusCard";

interface SidebarProps {
  activePage: AppPage;
  onNavigate?: (page: AppPage) => void;
}

export type AppPage = "photos" | "albums" | "folders" | "calendar" | "settings";

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const navClass = (page: AppPage) =>
    page === activePage
      ? "btn btn-sm btn-soft btn-primary justify-start"
      : "btn btn-sm btn-ghost justify-start";

  return (
    <aside className="hidden h-screen border-r border-base-300 bg-base-100 lg:sticky lg:top-0 lg:flex">
      <div className="flex h-full min-h-0 w-full flex-col gap-3 p-3">
        <div className="flex h-9 items-center gap-2 px-2 text-2xl font-bold text-primary">
          <div className="h-7 w-7 rounded-full bg-linear-to-br from-error via-warning to-info" />
          <span>immich.local</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <nav className="menu rounded-box bg-base-100 p-1">
            <button
              className={navClass("photos")}
              type="button"
              onClick={() => onNavigate?.("photos")}
            >
              <Image size={16} className="shrink-0" />
              <span>Photos</span>
            </button>
            <button
              className={navClass("albums")}
              type="button"
              onClick={() => onNavigate?.("albums")}
            >
              <Images size={16} className="shrink-0" />
              <span>Albums</span>
            </button>
            <button
              className={navClass("calendar")}
              type="button"
              onClick={() => onNavigate?.("calendar")}
            >
              <CalendarDays size={16} className="shrink-0" />
              <span>Calendar</span>
            </button>
            <button
              className={navClass("folders")}
              type="button"
              onClick={() => onNavigate?.("folders")}
            >
              <FolderTree size={16} className="shrink-0" />
              <span>Folders</span>
            </button>
          </nav>

          <div className="mt-3 px-2 text-xs font-semibold uppercase tracking-wide text-base-content/50">
            Library
          </div>
          <nav className="menu rounded-box bg-base-100 p-1">
            <button
              className="btn btn-sm btn-ghost justify-start"
              type="button"
              disabled
            >
              <Heart size={16} className="shrink-0" />
              <span>Favorites</span>
            </button>
          </nav>
        </div>

        <div className="shrink-0 space-y-3 px-2 pb-2">
          <nav className="menu rounded-box bg-base-100 p-1">
            <button
              className={navClass("settings")}
              type="button"
              onClick={() => onNavigate?.("settings")}
            >
              <Settings size={16} className="shrink-0" />
              <span>Settings</span>
            </button>
          </nav>
          <SyncStatusCard />
        </div>
      </div>
    </aside>
  );
}
