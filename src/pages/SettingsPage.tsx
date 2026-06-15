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
  getCamerasInScope,
  getCacheStats,
  getCachePath,
  getSettings,
  openFolderInFileExplorer,
  updateSettings,
} from "../api/tauri";
import { open } from "@tauri-apps/plugin-dialog";
import type { CacheStats, MyPhotosRule, Settings } from "../types";
import type { AppPage } from "../components/Layout/Sidebar";
import { MENU_ITEMS, type MenuItemKey } from "../components/Layout/Sidebar";
import { DaisyCalendarPicker } from "../components/Settings/DaisyCalendarPicker";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { useInvalidateSettings } from "../hooks/useSettings";
import { useI18n, type AppLocale } from "../i18n";

interface SettingsPageProps {
  onNavigate?: (page: AppPage) => void;
  onLogout?: () => void;
}

export function SettingsPage({ onNavigate, onLogout }: SettingsPageProps) {
  const { locale, setLocale, t } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cachePath, setCachePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingLocalFolder, setIsSavingLocalFolder] = useState(false);
  const [localFolderDraft, setLocalFolderDraft] = useState("");
  const [availableCameras, setAvailableCameras] = useState<string[]>([]);
  const [myPhotosRulesDraft, setMyPhotosRulesDraft] = useState<MyPhotosRule[]>(
    [],
  );
  const [isSavingMyPhotosRules, setIsSavingMyPhotosRules] = useState(false);
  const [isForcingFullSync, setIsForcingFullSync] = useState(false);
  const [isQuickSyncing, setIsQuickSyncing] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const {
    forceFullSync,
    checkForNewAssets,
    syncStatus,
    isSyncing,
    isChecking,
    progress,
    error,
  } = useSyncStatus();
  const appUpdate = useAppUpdate();
  const invalidateSettings = useInvalidateSettings();

  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoading(true);
        const [settingsData, stats, path, cameras] = await Promise.all([
          getSettings(),
          getCacheStats(),
          getCachePath(),
          getCamerasInScope({ kind: "all", filter: "all" }),
        ]);
        setSettings(settingsData);
        setLocalFolderDraft(settingsData.userLocalFolderPath ?? "");
        setMyPhotosRulesDraft(settingsData.myPhotosRules ?? []);
        setCacheStats(stats);
        setCachePath(path);
        setAvailableCameras(cameras);
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

  useEffect(() => {
    setMyPhotosRulesDraft(settings?.myPhotosRules ?? []);
  }, [settings?.myPhotosRules]);

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
      window.alert(t("settings.failedSaveLocalFolder"));
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
      window.alert(t("settings.failedOpenFolderPicker"));
    }
  };

  const handleClearCache = async () => {
    if (
      !window.confirm(t("settings.clearCacheConfirm"))
    ) {
      return;
    }
    // TODO: Implement cache clearing
    console.log("Cache clearing not yet implemented");
  };

  const handleAddMyPhotosRule = () => {
    const fallbackCamera = availableCameras[0] ?? "";
    setMyPhotosRulesDraft((current) => [
      ...current,
      {
        startDate: toLocalDateInputValue(new Date()),
        endDate: null,
        endDateCurrent: true,
        camera: fallbackCamera,
      },
    ]);
  };

  const handlePatchMyPhotosRule = (
    index: number,
    patch: Partial<MyPhotosRule>,
  ) => {
    setMyPhotosRulesDraft((current) =>
      current.map((rule, i) => {
        if (i !== index) {
          return rule;
        }
        const next = { ...rule, ...patch };
        if (next.endDateCurrent) {
          next.endDate = null;
        }
        return next;
      }),
    );
  };

  const handleRemoveMyPhotosRule = (index: number) => {
    setMyPhotosRulesDraft((current) => current.filter((_, i) => i !== index));
  };

  const handleSaveMyPhotosRules = async () => {
    if (!settings) {
      return;
    }
    const normalizedRules = normalizeMyPhotosRules(myPhotosRulesDraft);

    try {
      setIsSavingMyPhotosRules(true);
      const updated = await updateSettings({
        ...settings,
        myPhotosRules: normalizedRules,
      });
      setSettings(updated);
      setMyPhotosRulesDraft(updated.myPhotosRules ?? []);
      await invalidateSettings();
    } catch (error) {
      console.error("Failed to save My Photos rules:", error);
      window.alert(t("settings.failedSaveMyPhotosRules"));
    } finally {
      setIsSavingMyPhotosRules(false);
    }
  };

  const handleChangeLocale = async (nextLocale: AppLocale) => {
    if (!settings || settings.locale === nextLocale) {
      return;
    }

    const previous = settings;
    setLocale(nextLocale);
    setSettings({ ...settings, locale: nextLocale });

    try {
      setIsSaving(true);
      const updated = await updateSettings({
        ...settings,
        locale: nextLocale,
      });
      setSettings(updated);
      await invalidateSettings();
    } catch (error) {
      console.error("Failed to update locale setting:", error);
      setLocale(previous.locale);
      setSettings(previous);
      window.alert(t("settings.saveFailed"));
    } finally {
      setIsSaving(false);
    }
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

  const handleQuickSync = async () => {
    try {
      setIsQuickSyncing(true);
      await checkForNewAssets();
    } catch (error) {
      console.error("Failed to run quick sync:", error);
    } finally {
      setIsQuickSyncing(false);
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
      return date.toLocaleDateString(locale, {
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
  const hasMyPhotosRuleChanges =
    JSON.stringify(myPhotosRulesDraft) !==
    JSON.stringify(settings?.myPhotosRules ?? []);

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
            {t("settings.exit")}
          </button>
          <h1 className="text-3xl font-bold text-base-content">
            {t("settings.title")}
          </h1>
          <p className="text-base-content/60">{t("settings.subtitle")}</p>
        </div>

        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">{t("settings.languageTitle")}</h2>
            <p className="text-sm text-base-content/70 mb-3">
              {t("settings.languageDescription")}
            </p>
            <label className="form-control w-full max-w-sm">
              <span className="label-text mb-1">
                {t("settings.languageLabel")}
              </span>
              <select
                className="select select-bordered"
                value={settings?.locale ?? locale}
                disabled={isSaving || !settings}
                onChange={(event) => {
                  void handleChangeLocale(
                    event.currentTarget.value as AppLocale,
                  );
                }}
              >
                <option value="en-CA">{t("settings.localeEnCa")}</option>
                <option value="fr-CA">{t("settings.localeFrCa")}</option>
              </select>
            </label>
            {isSaving && (
              <p className="mt-2 text-xs text-base-content/60">
                {t("settings.languageSaving")}
              </p>
            )}
          </div>
        </div>

        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">{t("settings.sectionSync")}</h2>
            <p className="text-sm text-base-content/70 mb-4">
              {t("settings.syncDescription")}
            </p>

            {isQuickSyncing && !isSyncing ? (
              <div className="flex items-center gap-2 mb-3">
                <span className="loading loading-spinner loading-xs"></span>
                <span className="text-xs text-base-content/70">
                  {t("settings.quickSyncRunning")}
                </span>
              </div>
            ) : isForcingFullSync && !isSyncing ? (
              <>
                <progress className="progress progress-primary progress-sm mb-2"></progress>
                <div className="text-xs text-base-content/70 mb-3">
                  {t("settings.fullSyncStarting")}
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
                  {t("settings.syncedCount", {
                    processed: syncStatus.processedAssets,
                    total: syncStatus.totalAssets,
                  })}
                </div>
              </>
            ) : isChecking ? (
              <div className="flex items-center gap-2 mb-3">
                <span className="loading loading-spinner loading-xs"></span>
                <span className="text-xs text-base-content/70">
                  {t("settings.checkingNewAssets")}
                </span>
              </div>
            ) : isSyncComplete && syncStatus ? (
              <div className="flex items-center gap-2 mb-3">
                <Check size={16} className="text-success" />
                <span className="text-xs font-medium text-success">
                  {t("settings.lastFullSync", {
                    date: formatDate(syncStatus.lastSyncCompletedAt),
                  })}
                </span>
              </div>
            ) : (
              <div className="text-xs text-base-content/70 mb-3">
                {t("settings.readyToSync")}
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  void handleQuickSync();
                }}
                disabled={isQuickSyncing || isChecking || isSyncing}
                className="btn btn-outline btn-primary gap-2"
              >
                <RefreshCcw size={16} />
                {isQuickSyncing || isChecking
                  ? t("settings.quickSyncingCta")
                  : t("settings.quickSyncCta")}
              </button>

              <button
                type="button"
                onClick={() => {
                  void handleForceFullSync();
                }}
                disabled={isForcingFullSync || isSyncing}
                className="btn btn-outline btn-warning gap-2"
              >
                <RefreshCcw size={16} />
                {isForcingFullSync && t("settings.startFullSyncCta")}
                {isSyncing && !isForcingFullSync && t("settings.syncingCta")}
                {!isForcingFullSync &&
                  !isSyncing &&
                  t("settings.forceFullSyncCta")}
              </button>
            </div>

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
            <h2 className="card-title">{t("settings.sectionNavigation")}</h2>
            <p className="text-sm text-base-content/70 mb-2">
              {t("settings.navigationDescription")}
            </p>
            <div className="flex flex-col">
              {MENU_ITEMS.map(({ key, labelKey, icon: Icon }) => {
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
                    <span className="label-text">{t(labelKey)}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {/* Live Photo Settings */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">{t("settings.sectionMyPhotos")}</h2>
            <p className="text-sm text-base-content/70 mb-3">
              {t("settings.myPhotosDescription")}
            </p>

            <div className="space-y-3">
              {myPhotosRulesDraft.length === 0 ? (
                <div className="rounded-lg border border-dashed border-base-300 p-3 text-sm text-base-content/60">
                  {t("settings.myPhotosEmpty")}
                </div>
              ) : (
                myPhotosRulesDraft.map((rule, index) => (
                  <div
                    key={`my-photo-rule-${index}`}
                    className="rounded-lg border border-base-300 bg-base-200/50 p-3"
                  >
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="form-control">
                        <span className="label-text text-xs">
                          {t("settings.myPhotosStartDate")}
                        </span>
                        <DaisyCalendarPicker
                          value={rule.startDate}
                          onChange={(value) =>
                            handlePatchMyPhotosRule(index, {
                              startDate: value,
                            })
                          }
                        />
                      </label>

                      <label className="form-control">
                        <span className="label-text text-xs">
                          {t("settings.myPhotosCamera")}
                        </span>
                        <select
                          className="select select-sm select-bordered"
                          value={rule.camera}
                          onChange={(event) =>
                            handlePatchMyPhotosRule(index, {
                              camera: event.currentTarget.value,
                            })
                          }
                        >
                          <option value="">
                            {t("settings.myPhotosSelectCamera")}
                          </option>
                          {availableCameras.map((camera) => (
                            <option key={camera} value={camera}>
                              {camera}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="form-control">
                        <span className="label-text text-xs">
                          {t("settings.myPhotosEndDate")}
                        </span>
                        <DaisyCalendarPicker
                          value={rule.endDate ?? ""}
                          disabled={rule.endDateCurrent}
                          onChange={(value) =>
                            handlePatchMyPhotosRule(index, {
                              endDate: value || null,
                            })
                          }
                        />
                      </label>

                      <label className="label cursor-pointer justify-start gap-3 self-end">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm checkbox-primary"
                          checked={rule.endDateCurrent}
                          onChange={(event) =>
                            handlePatchMyPhotosRule(index, {
                              endDateCurrent: event.currentTarget.checked,
                            })
                          }
                        />
                        <span className="label-text">
                          {t("settings.myPhotosUseCurrentDate")}
                        </span>
                      </label>
                    </div>

                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs text-error"
                        onClick={() => handleRemoveMyPhotosRule(index)}
                      >
                        {t("settings.myPhotosRemoveRule")}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-between">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={handleAddMyPhotosRule}
              >
                {t("settings.myPhotosAddRule")}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!hasMyPhotosRuleChanges || isSavingMyPhotosRules}
                onClick={() => {
                  void handleSaveMyPhotosRules();
                }}
              >
                {isSavingMyPhotosRules
                  ? t("settings.saving")
                  : t("settings.myPhotosSaveRules")}
              </button>
            </div>
          </div>
        </div>

        {/* Live Photo Settings */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">{t("settings.sectionLivePhotos")}</h2>{" "}
            <div className="form-control">
              <label className="label cursor-pointer">
                <span className="label-text">
                  {t("settings.livePhotosAutoplay")}
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
                {t("settings.livePhotosHelp")}
              </p>
            </div>
          </div>
        </div>

        {/* Cache Settings */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">{t("settings.sectionCache")}</h2>

            <div className="form-control mb-4">
              <label className="label">
                <span className="label-text font-medium">
                  {t("settings.localFolderLabel")}
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={localFolderDraft}
                  onChange={(event) => setLocalFolderDraft(event.target.value)}
                  placeholder={t("settings.localFolderPlaceholder")}
                  className="input input-bordered input-sm flex-1 text-sm"
                />
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    void handlePickLocalFolderPath();
                  }}
                >
                  {t("settings.browse")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    void handleSaveLocalFolderPath();
                  }}
                  disabled={isSavingLocalFolder}
                >
                  {isSavingLocalFolder
                    ? t("settings.saving")
                    : t("settings.save")}
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
                      window.alert(t("settings.failedOpenLocalFolder"));
                    });
                  }}
                >
                  {t("settings.openLocalFolder")}
                </button>
              </div>
              <p className="mt-1 text-sm text-base-content/60">
                {t("settings.localFolderHelp")}
              </p>
            </div>

            {/* Cache Path */}
            <div className="form-control mb-4">
              <label className="label">
                <span className="label-text font-medium">
                  {t("settings.cacheLocation")}
                </span>
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
                          window.alert(t("settings.failedOpenCacheFolder"));
                        },
                      );
                    }
                  }}
                >
                  <FolderOpen size={16} />
                  {t("settings.open")}
                </button>
              </div>
            </div>

            {/* Cache Usage */}
            <div className="divider my-2"></div>

            <div className="space-y-3">
              <p className="text-sm font-medium text-base-content">
                {t("settings.storageUsage")}
              </p>

              {/* Total Size */}
              <div className="flex items-center justify-between rounded-lg bg-base-200 p-3">
                <span className="text-sm text-base-content/70">
                  {t("settings.totalCacheSize")}
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
                      {t("settings.videos")}
                    </p>
                    <p className="text-xs text-base-content/60">
                      {(cacheStats?.videosCount ?? 0) === 1
                        ? t("settings.fileCountSingular", {
                            count: cacheStats?.videosCount ?? 0,
                          })
                        : t("settings.fileCountPlural", {
                            count: cacheStats?.videosCount ?? 0,
                          })}
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
                      {t("settings.thumbnails")}
                    </p>
                    <p className="text-xs text-base-content/60">
                      {(cacheStats?.thumbnailsCount ?? 0) === 1
                        ? t("settings.fileCountSingular", {
                            count: cacheStats?.thumbnailsCount ?? 0,
                          })
                        : t("settings.fileCountPlural", {
                            count: cacheStats?.thumbnailsCount ?? 0,
                          })}
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
              {t("settings.clearCache")}
            </button>
            <p className="mt-2 text-xs text-base-content/60">
              {t("settings.clearCacheHelp")}
            </p>
          </div>
        </div>

        {/* Account */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">{t("settings.sectionAccount")}</h2>
            <p className="text-sm text-base-content/70 mb-4">
              {t("settings.accountDescription")}
            </p>
            <button
              type="button"
              onClick={onLogout}
              className="btn btn-outline btn-error gap-2"
            >
              <LogOut size={16} />
              {t("settings.signOut")}
            </button>
          </div>
        </div>

        {/* App Updates */}
        <div className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">{t("settings.sectionUpdates")}</h2>
            <p className="text-sm text-base-content/70 mb-1">
              {t("settings.currentVersion", { version: appVersion ?? "..." })}
            </p>

            {appUpdate.status === "checking" && (
              <div className="flex items-center gap-2 mb-3">
                <span className="loading loading-spinner loading-xs"></span>
                <span className="text-xs text-base-content/70">
                  {t("settings.updatesChecking")}
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
                  {t("settings.updatesDownloading", {
                    version: appUpdate.newVersion ?? "",
                  })}
                </div>
              </div>
            )}

            {appUpdate.status === "uptodate" && (
              <div className="flex items-center gap-2 mb-3">
                <Check size={16} className="text-success" />
                <span className="text-xs font-medium text-success">
                  {t("settings.updatesLatest")}
                </span>
              </div>
            )}

            {appUpdate.status === "error" && (
              <div className="alert alert-error alert-sm mb-3">
                <span className="text-xs">
                  {appUpdate.error ?? t("settings.updatesCheckFailed")}
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
                {t("settings.restartInstall", {
                  version: appUpdate.newVersion ?? "",
                })}
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
                {t("settings.checkForUpdates")}
              </button>
            )}
          </div>
        </div>

        {/* About */}
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">{t("settings.sectionAbout")}</h2>
            <p className="text-sm text-base-content/70">
              immich.local v{appVersion ?? "0.1.0"}
            </p>
            <p className="text-xs text-base-content/60 mt-2">
              {t("settings.aboutDescription")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function toLocalDateInputValue(date: Date): string {
  const timezoneAdjusted = new Date(
    date.getTime() - date.getTimezoneOffset() * 60_000,
  );
  return timezoneAdjusted.toISOString().slice(0, 10);
}

function normalizeMyPhotosRules(rules: MyPhotosRule[]): MyPhotosRule[] {
  return rules
    .map((rule) => {
      const startDate = rule.startDate.trim();
      const camera = rule.camera.trim();
      const endDateCurrent = rule.endDateCurrent === true;
      const endDate = endDateCurrent
        ? null
        : (rule.endDate ?? "").trim() || null;

      if (!startDate || !camera) {
        return null;
      }

      if (!endDateCurrent && !endDate) {
        return null;
      }

      return {
        startDate,
        endDate,
        endDateCurrent,
        camera,
      } satisfies MyPhotosRule;
    })
    .filter((rule): rule is MyPhotosRule => rule != null);
}
