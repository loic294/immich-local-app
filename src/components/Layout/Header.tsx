import { Search, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getProfileImage } from "../../api/tauri";

interface HeaderProps {
  searchInput: string;
  onSearchChange: (value: string) => void;
  serverUrl: string;
  userId: string;
  userName: string;
  searchPlaceholder?: string;
}

export function Header({
  searchInput,
  onSearchChange,
  serverUrl,
  userId,
  userName,
  searchPlaceholder = "Search your photos",
}: HeaderProps) {
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
            placeholder={searchPlaceholder}
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
        <button className="btn btn-sm btn-ghost" type="button">
          <Upload size={14} className="shrink-0" />
          <span>Upload</span>
        </button>
        <div className="flex items-center gap-2">
          {profileImage ? (
            <div className="avatar">
              <div className="w-8 rounded-full">
                <img
                  src={profileImage}
                  alt="Profile"
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
          <div>
            <p className="m-0 text-xs font-semibold text-base-content">
              {userName}
            </p>
            <p className="m-0 max-w-40 truncate text-[11px] text-base-content/60">
              {serverUrl}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}
