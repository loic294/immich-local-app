import { Funnel, LogOut, Search, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getProfileImage } from "../../api/tauri";
import { SortButton } from "../Filters/SortButton";
import type { SortPreference } from "../../types";
import { useI18n } from "../../i18n";

interface HeaderProps {
  searchInput: string;
  onSearchChange: (value: string) => void;
  serverUrl: string;
  userId: string;
  userName: string;
  onLogout: () => void;
  searchPlaceholder?: string;
  /** Whether to show the Filter button (only on photo grid views). */
  showFilterButton?: boolean;
  /** Whether any filter is currently active (highlights the button). */
  filterActive?: boolean;
  /** Whether the filter bar is currently open. */
  filterOpen?: boolean;
  onToggleFilter?: () => void;
  /** Whether to show the Sort button (only on photo grid views). */
  showSortButton?: boolean;
  sortPreference?: SortPreference;
  onSortChange?: (patch: Partial<SortPreference>) => void;
}

export function Header({
  searchInput,
  onSearchChange,
  serverUrl,
  userId,
  userName,
  onLogout,
  searchPlaceholder,
  showFilterButton = false,
  filterActive = false,
  filterOpen = false,
  onToggleFilter,
  showSortButton = false,
  sortPreference,
  onSortChange,
}: HeaderProps) {
  const { t } = useI18n();
  const [profileImage, setProfileImage] = useState<string | null>(null);

  const initials = useMemo(() => {
    const value = userName.trim();
    if (!value) {
      return "U";
    }

    const parts = value.split(/[._\-\s]+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
    }
    return value.slice(0, 2).toUpperCase();
  }, [userName]);

  useEffect(() => {
    let cancelled = false;

    async function loadProfileImage() {
      try {
        const value = await getProfileImage(userId);
        if (!cancelled) {
          setProfileImage(value);
        }
      } catch {
        if (!cancelled) {
          setProfileImage(null);
        }
      }
    }

    void loadProfileImage();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <header className="navbar border-b border-base-300 bg-base-100 px-3 sm:px-4">
      <div className="navbar-start">
        <label
          className="input input-bordered flex w-full min-w-[16rem] items-center gap-2 rounded-full sm:min-w-[20rem] lg:min-w-md"
          htmlFor="asset-search"
        >
          <Search size={16} className="text-base-content/60" />
          <input
            id="asset-search"
            placeholder={searchPlaceholder ?? t("header.searchPhotos")}
            type="text"
            className="grow"
            value={searchInput}
            onChange={(event) => {
              onSearchChange(event.target.value);
            }}
          />
        </label>
      </div>

      <div className="navbar-end gap-2">
        {showSortButton && sortPreference && onSortChange && (
          <SortButton preference={sortPreference} onChange={onSortChange} />
        )}
        {showFilterButton && (
          <button
            className={`btn btn-sm ${
              filterActive || filterOpen ? "btn-primary" : "btn-ghost"
            }`}
            type="button"
            onClick={onToggleFilter}
            aria-pressed={filterOpen}
            aria-label={t("header.filterAria")}
          >
            <Funnel size={14} className="shrink-0" />
            <span>{t("header.filter")}</span>
          </button>
        )}
        <details className="dropdown dropdown-end">
          <summary
            className="btn btn-ghost btn-circle list-none"
            aria-label={t("header.accountMenuAria")}
          >
            {profileImage ? (
              <div className="avatar">
                <div className="w-8 rounded-full">
                  <img
                    src={profileImage}
                    alt={t("header.profileAlt")}
                    className="object-cover"
                  />
                </div>
              </div>
            ) : (
              <div className="avatar placeholder">
                <div className="w-8 rounded-full bg-primary text-primary-content text-xs font-bold">
                  {initials}
                </div>
              </div>
            )}
          </summary>
          <div className="dropdown-content z-20 mt-2 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow">
            <p className="m-0 text-sm font-semibold text-base-content">
              {userName}
            </p>
            <p className="m-0 truncate text-xs text-base-content/60">
              {serverUrl}
            </p>
            <div className="divider my-2" />
            <button
              type="button"
              className="btn btn-sm btn-ghost justify-start text-error"
              onClick={onLogout}
            >
              <LogOut size={14} className="shrink-0" />
              <span>{t("header.signOut")}</span>
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
