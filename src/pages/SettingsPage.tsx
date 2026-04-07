import { useEffect, useState } from "react";
import { Trash2, FolderOpen } from "lucide-react";
import {
  getCacheStats,
  getCachePath,
  getSettings,
  updateSettings,
} from "../api/tauri";
import type { CacheStats, Settings } from "../types";
import type { AppPage } from "../components/Layout/Sidebar";

interface SettingsPageProps {
  onNavigate?: (page: AppPage) => void;
}

export function SettingsPage({ onNavigate }: SettingsPageProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cachePath, setCachePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoading(true);
        const [settingsData, stats, path] = await Promise.all([
          getSettings(),
          getCacheStats(),
          getCachePath(),
        ]);
        setSettings(settingsData);
        setCacheStats(stats);
        setCachePath(path);
      } catch (error) {
        console.error("Failed to load settings:", error);
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, []);

  const handleToggleLivePhotoAutoplay = async () => {
    if (!settings) return;

    try {
      setIsSaving(true);
      const updated = await updateSettings({
        ...settings,
        livePhotoAutoplay: !settings.livePhotoAutoplay,
      });
      setSettings(updated);
    } catch (error) {
      console.error("Failed to update settings:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearCache = async () => {
    if (
      !window.confirm(
        "Are you sure you want to clear all cached videos and thumbnails? This will free up space but may take time to reload media.",
      )
    ) {
      return;
    }
    // TODO: Implement cache clearing
    console.log("Cache clearing not yet implemented");
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-100">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base-100 pt-24">
      <div className="mx-auto max-w-2xl px-4 pb-12">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-base-content">Settings</h1>
          <p className="text-base-content/60">
            Manage your app preferences and cache
          </p>
        </div>

        {/* Live Photo Settings */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Live Photos</h2>
            <div className="form-control">
              <label className="label cursor-pointer">
                <span className="label-text">
                  Automatically play live photos on hover
                </span>
                <input
                  type="checkbox"
                  className="checkbox checkbox-primary"
                  checked={settings?.livePhotoAutoplay ?? false}
                  onChange={handleToggleLivePhotoAutoplay}
                  disabled={isSaving}
                />
              </label>
              <p className="mt-2 text-sm text-base-content/60">
                When disabled, you can still play live photos manually using the
                button in the viewer.
              </p>
            </div>
          </div>
        </div>

        {/* Cache Settings */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Cache & Storage</h2>

            {/* Cache Path */}
            <div className="form-control mb-4">
              <label className="label">
                <span className="label-text font-medium">Cache Location</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={cachePath || ""}
                  readOnly
                  className="input input-bordered input-sm flex-1 text-sm"
                />
                <button
                  type="button"
                  className="btn btn-outline btn-sm gap-2"
                  onClick={() => {
                    if (cachePath) {
                      // Open in file explorer
                      window.location.href = `file://${cachePath}`;
                    }
                  }}
                >
                  <FolderOpen size={16} />
                  Open
                </button>
              </div>
            </div>

            {/* Cache Usage */}
            <div className="divider my-2"></div>

            <div className="space-y-3">
              <p className="text-sm font-medium text-base-content">
                Storage Usage
              </p>

              {/* Total Size */}
              <div className="flex items-center justify-between rounded-lg bg-base-200 p-3">
                <span className="text-sm text-base-content/70">
                  Total Cache Size
                </span>
                <span className="font-mono font-bold text-primary">
                  {formatBytes(cacheStats?.totalSize ?? 0)}
                </span>
              </div>

              {/* Videos */}
              <div className="rounded-lg bg-base-200/60 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-base-content">
                      Videos
                    </p>
                    <p className="text-xs text-base-content/60">
                      {cacheStats?.videosCount ?? 0} file
                      {(cacheStats?.videosCount ?? 0) !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <span className="font-mono text-sm font-semibold text-base-content">
                    {formatBytes(cacheStats?.totalVideosSize ?? 0)}
                  </span>
                </div>
              </div>

              {/* Thumbnails */}
              <div className="rounded-lg bg-base-200/60 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-base-content">
                      Thumbnails
                    </p>
                    <p className="text-xs text-base-content/60">
                      {cacheStats?.thumbnailsCount ?? 0} file
                      {(cacheStats?.thumbnailsCount ?? 0) !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <span className="font-mono text-sm font-semibold text-base-content">
                    {formatBytes(cacheStats?.totalThumbnailsSize ?? 0)}
                  </span>
                </div>
              </div>
            </div>

            <div className="divider my-4"></div>

            <button
              type="button"
              onClick={handleClearCache}
              className="btn btn-outline btn-error btn-sm gap-2 w-full"
            >
              <Trash2 size={16} />
              Clear Cache
            </button>
            <p className="mt-2 text-xs text-base-content/60">
              Clearing the cache will not affect your photos. They will be
              re-downloaded as needed.
            </p>
          </div>
        </div>

        {/* About */}
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">About</h2>
            <p className="text-sm text-base-content/70">immich.local v0.1.0</p>
            <p className="text-xs text-base-content/60 mt-2">
              A local photo browsing app for Immich servers with support for
              live photos, albums, and offline caching.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
