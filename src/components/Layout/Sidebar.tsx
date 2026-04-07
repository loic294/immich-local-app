import { Heart, Image, MapPin, Search, Share2 } from "lucide-react";

interface SidebarProps {
  onNavigate?: (page: string) => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  return (
    <aside className="hidden flex-col gap-3 border-r border-base-300 bg-base-100 p-3 lg:flex">
      <div className="flex h-9 items-center gap-2 px-2 text-3xl font-bold text-primary">
        <div className="h-3.5 w-3.5 rounded-full bg-linear-to-br from-error via-warning to-info" />
        <span>immich.local</span>
      </div>

      <nav className="menu rounded-box bg-base-100 p-1">
        <button
          className="btn btn-sm btn-soft btn-primary justify-start"
          type="button"
          onClick={() => onNavigate?.("photos")}
        >
          <Image size={16} className="shrink-0" />
          <span>Photos</span>
        </button>
        <button
          className="btn btn-sm btn-ghost justify-start"
          type="button"
          onClick={() => onNavigate?.("explore")}
        >
          <Search size={16} className="shrink-0" />
          <span>Explore</span>
        </button>
        <button
          className="btn btn-sm btn-ghost justify-start"
          type="button"
          onClick={() => onNavigate?.("map")}
        >
          <MapPin size={16} className="shrink-0" />
          <span>Map</span>
        </button>
        <button
          className="btn btn-sm btn-ghost justify-start"
          type="button"
          onClick={() => onNavigate?.("sharing")}
        >
          <Share2 size={16} className="shrink-0" />
          <span>Sharing</span>
        </button>
      </nav>

      <div className="px-2 text-xs font-semibold uppercase tracking-wide text-base-content/50">
        Library
      </div>
      <nav className="menu rounded-box bg-base-100 p-1">
        <button
          className="btn btn-sm btn-ghost justify-start"
          type="button"
          onClick={() => onNavigate?.("favorites")}
        >
          <Heart size={16} className="shrink-0" />
          <span>Favorites</span>
        </button>
      </nav>
    </aside>
  );
}
