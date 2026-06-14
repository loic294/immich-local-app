import { useEffect, useState } from "react";
import {
  Trash2,
  FolderOpen,
  LogOut,
  ArrowLeft,
  RefreshCcw,
  Check,
  Download,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import {
  getCacheStats,
  getCachePath,
  getSettings,
  openFolderInFileExplorer,
  updateSettings,
} from "../api/tauri";
import { open } from "@tauri-apps/plugin-dialog";
import type { CacheStats, Settings } from "../types";
import type { AppPage } from "../components/Layout/Sidebar";
import { MENU_ITEMS, type MenuItemKey } from "../components/Layout/Sidebar";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { useInvalidateSettings } from "../hooks/useSettings";

interface SettingsPageProps {
  onNavigate?: (page: AppPage) => void;
  onLogout?: () => void;
}

export function SettingsPage({ onNavigate, onLogout }: SettingsPageProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cachePath, setCachePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingLocalFolder, setIsSavingLocalFolder] = useState(false);
  const [localFolderDraft, setLocalFolderDraft] = useState("");
  const [isForcingFullSync, setIsForcingFullSync] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const { forceFullSync, syncStatus, isSyncing, isChecking, progress, error } =
    useSyncStatus({ enableAutoCheck: false });
  const appUpdate = useAppUpdate();
  const invalidateSettings = useInvalidateSettings();

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
        setLocalFolderDraft(settingsData.userLocalFolderPath ?? "");
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

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch((error) => {
        console.error("Failed to read app version:", error);
      });
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

  const handleToggleMenuItem = async (key: MenuItemKey) => {
    if (!settings) return;

    const current = settings.menuItems ?? [];
    const isCurrentlyVisible = current.includes(key);
    // Preserve the canonical order from MENU_ITEMS so the sidebar stays stable.
    const nextMenuItems = isCurrentlyVisible
      ? current.filter((item) => item !== key)
      : MENU_ITEMS.filter(
          (item) => item.key === key || current.includes(item.key),
        ).map((item) => item.key);

    const previous = settings;
    // Optimistic update so the toggle feels instant.
    setSettings({ ...settings, menuItems: nextMenuItems });

    try {
      setIsSaving(true);
      const updated = await updateSettings({
        ...previous,
        menuItems: nextMenuItems,
      });
      setSettings(updated);
      await invalidateSettings();
    } catch (error) {
      console.error("Failed to update menu items:", error);
      setSettings(previous);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveLocalFolderPath = async () => {
    if (!settings) return;

    const nextPath = localFolderDraft.trim();
    if (nextPath === settings.userLocalFolderPath) {
      return;
    }

    try {
      setIsSavingLocalFolder(true);
      const updated = await updateSettings({
        ...settings,
        userLocalFolderPath: nextPath,
      });
      setSettings(updated);
      setLocalFolderDraft(updated.userLocalFolderPath ?? "");
    } catch (error) {
      console.error("Failed to save local folder path:", error);
      window.alert("Failed to save local folder path.");
    } finally {
      setIsSavingLocalFolder(false);
    }
  };

  const handlePickLocalFolderPath = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (!selected || Array.isArray(selected)) {
        return;
      }

      setLocalFolderDraft(selected);
    } catch (error) {
      console.error("Failed to open folder picker:", error);
      window.alert("Failed to open folder picker.");
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

  const handleForceFullSync = async () => {
    try {
      setIsForcingFullSync(true);
      await forceFullSync();
    } catch (error) {
      console.error("Failed to force full sync:", error);
    } finally {
      setIsForcingFullSync(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  const formatDate = (dateString: string | null): string => {
    if (!dateString) return "";
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateString;
    }
  };

  const isSyncComplete =
    syncStatus?.lastSyncCompletedAt !== null &&
    syncStatus?.lastSyncCompletedAt !== undefined;

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-100">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-y-auto bg-base-100">
      <div className="mx-auto max-w-2xl px-4 pb-12 pt-24">
        <div className="mb-8">
          <button
            type="button"
            className="btn btn-sm btn-ghost gap-2 mb-3"
            onClick={() => onNavigate?.("photos")}
          >
            <ArrowLeft size={16} />
            Exit Settings
          </button>
          <h1 className="text-3xl font-bold text-base-content">Settings</h1>
          <p className="text-base-content/60">
            Manage your app preferences and cache
          </p>
        </div>

        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Sync</h2>
            <p className="text-sm text-base-content/70 mb-4">
              Restart synchronization from the beginning and refresh all local
              metadata.
            </p>

            {isForcingFullSync && !isSyncing ? (
              <>
                <progress className="progress progress-primary progress-sm mb-2"></progress>
                <div className="text-xs text-base-content/70 mb-3">
                  Starting full sync...
                </div>
              </>
            ) : isSyncing && syncStatus ? (
              <>
                <progress
                  className="progress progress-primary progress-sm mb-2"
                  value={progress}
                  max="100"
                ></progress>
                <div className="text-xs text-base-content/70 mb-3">
                  {syncStatus.processedAssets} / {syncStatus.totalAssets} photos
                  synced
                </div>
              </>
            ) : isChecking ? (
              <div className="flex items-center gap-2 mb-3">
                <span className="loading loading-spinner loading-xs"></span>
                <span className="text-xs text-base-content/70">
                  Checking for new assets...
                </span>
              </div>
            ) : isSyncComplete && syncStatus ? (
              <div className="flex items-center gap-2 mb-3">
                <Check size={16} className="text-success" />
                <span className="text-xs font-medium text-success">
                  Last full sync: {formatDate(syncStatus.lastSyncCompletedAt)}
                </span>
              </div>
            ) : (
              <div className="text-xs text-base-content/70 mb-3">
                Ready to start full sync
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                void handleForceFullSync();
              }}
              disabled={isForcingFullSync || isSyncing}
              className="btn btn-outline btn-warning gap-2"
            >
              <RefreshCcw size={16} />
              {isForcingFullSync && "Starting Full Sync..."}
              {isSyncing && !isForcingFullSync && "Syncing..."}
              {isChecking && !isForcingFullSync && !isSyncing && "Checking..."}
              {!isForcingFullSync &&
                !isSyncing &&
                !isChecking &&
                "Force Full Sync"}
            </button>

            {error && (
              <div className="alert alert-error alert-sm mt-3">
                <span className="text-xs">{error}</span>
              </div>
            )}
          </div>
        </div>

        {/* Navigation Menu Settings */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Navigation Menu</h2>
            <p className="text-sm text-base-content/70 mb-2">
              Choose which items appear in the sidebar. Settings is always
              shown.
            </p>
            <div className="flex flex-col">
              {MENU_ITEMS.map(({ key, label, icon: Icon }) => {
                const checked = settings?.menuItems?.includes(key) ?? false;
                return (
                  <label
                    key={key}
                    className="label cursor-pointer justify-start gap-3"
                  >
                    <input
                      type="checkbox"
                      className="checkbox checkbox-primary"
                      checked={checked}
                      onChange={() => {
                        void handleToggleMenuItem(key);
                      }}
                      disabled={isSaving || !settings}
                    />
                    <Icon size={16} className="shrink-0 text-base-content/70" />
                    <span className="label-text">{label}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {/* Live Photo Settings */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Live Photos</h2>{" "}
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

            <div className="form-control mb-4">
              <label className="label">
                <span className="label-text font-medium">
                  Local Files Folder
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={localFolderDraft}
                  onChange={(event) => setLocalFolderDraft(event.target.value)}
                  placeholder="Choose a folder for copied local files"
                  className="input input-bordered input-sm flex-1 text-sm"
                />
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    void handlePickLocalFolderPath();
                  }}
                >
                  Browse
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    void handleSaveLocalFolderPath();
                  }}
                  disabled={isSavingLocalFolder}
                >
                  {isSavingLocalFolder ? "Saving..." : "Save"}
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={!settings?.userLocalFolderPath}
                  onClick={() => {
                    if (!settings?.userLocalFolderPath) {
                      return;
                    }
                    void openFolderInFileExplorer(
                      settings.userLocalFolderPath,
                    ).catch((error) => {
                      console.error("Failed to open local folder:", error);
                      window.alert(
                        "Failed to open local folder in file explorer.",
                      );
                    });
                  }}
                >
                  Open local folder
                </button>
              </div>
              <p className="mt-1 text-sm text-base-content/60">
                Selected assets are copied here when using Open in file
                explorer. This folder is separate from the app cache.
              </p>
            </div>

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
                      void openFolderInFileExplorer(cachePath).catch(
                        (error) => {
                          console.error("Failed to open cache folder:", error);
                          window.alert(
                            "Failed to open cache folder in file explorer.",
                          );
                        },
                      );
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

        {/* Account */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Account</h2>
            <p className="text-sm text-base-content/70 mb-4">
              Sign out to connect to a different Immich server or change your
              API key.
            </p>
            <button
              type="button"
              onClick={onLogout}
              className="btn btn-outline btn-error gap-2"
            >
              <LogOut size={16} />
              Sign Out
            </button>
          </div>
        </div>

        {/* App Updates */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">App Updates</h2>
            <p className="text-sm text-base-content/70 mb-1">
              Current version: {appVersion ?? "…"}
            </p>

            {appUpdate.status === "checking" && (
              <div className="flex items-center gap-2 mb-3">
                <span className="loading loading-spinner loading-xs"></span>
                <span className="text-xs text-base-content/70">
                  Checking for updates…
                </span>
              </div>
            )}

            {appUpdate.status === "downloading" && (
              <div className="mb-3">
                <progress
                  className="progress progress-primary progress-sm mb-1"
                  value={appUpdate.progress ?? 0}
                  max="100"
                ></progress>
                <div className="text-xs text-base-content/70">
                  Downloading update {appUpdate.newVersion}…
                </div>
              </div>
            )}

            {appUpdate.status === "uptodate" && (
              <div className="flex items-center gap-2 mb-3">
                <Check size={16} className="text-success" />
                <span className="text-xs font-medium text-success">
                  You are on the latest version.
                </span>
              </div>
            )}

            {appUpdate.status === "error" && (
              <div className="alert alert-error alert-sm mb-3">
                <span className="text-xs">
                  {appUpdate.error ?? "Failed to check for updates."}
                </span>
              </div>
            )}

            {appUpdate.status === "ready" ? (
              <button
                type="button"
                onClick={() => {
                  void appUpdate.installAndRelaunch();
                }}
                className="btn btn-primary gap-2"
              >
                <RefreshCcw size={16} />
                Restart to install {appUpdate.newVersion}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void appUpdate.checkForUpdate(true);
                }}
                disabled={
                  appUpdate.status === "checking" ||
                  appUpdate.status === "downloading"
                }
                className="btn btn-outline gap-2"
              >
                <Download size={16} />
                Check for Updates
              </button>
            )}
          </div>
        </div>

        {/* About */}
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">About</h2>
            <p className="text-sm text-base-content/70">
              immich.local v{appVersion ?? "0.1.0"}
            </p>
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
