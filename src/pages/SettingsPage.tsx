import { WindowHeader } from "../components/Layout/WindowHeader";
import { useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  LogOut,
  ArrowLeft,
  RefreshCcw,
  Check,
  Download,
  X,
  ArrowUp,
  ArrowDown,
  GripVertical,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import {
  getCamerasInScope,
  getCachePath,
  getSettings,
  openFolderInFileExplorer,
  refreshAlbumList,
  updateSettings,
} from "../api/tauri";
import { open } from "@tauri-apps/plugin-dialog";
import type { MenuItemPreference, MyPhotosRule, Settings } from "../types";
import type { AppPage } from "../components/Layout/Sidebar";
import { MENU_ITEMS, type MenuItemKey } from "../components/Layout/Sidebar";
import { DaisyCalendarPicker } from "../components/Settings/DaisyCalendarPicker";
import { StorageSettings } from "../components/Settings/StorageSettings";
import { AccountsBaseDirectorySettings } from "../components/Settings/AccountsBaseDirectorySettings";
import { MediaSettings } from "../components/Media/MediaSettings";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { useInvalidateSettings } from "../hooks/useSettings";
import { useAccounts } from "../hooks/useAccounts";
import { useI18n, type AppLocale } from "../i18n";

interface SettingsPageProps {
  onNavigate?: (page: AppPage) => void;
  onLogout?: () => void;
}

export function SettingsPage({ onNavigate, onLogout }: SettingsPageProps) {
  const [section, setSection] = useState("general");
  const settingsContentRef = useRef<HTMLDivElement>(null);
  const sections = [
    ["general", "settings.sectionGeneral"],
    ["navigation", "settings.sectionNavigation"],
    ["sync", "settings.sectionSync"],
    ["storage", "settings.sectionStorage"],
    ["video", "settings.sectionVideo"],
    ["editing", "settings.sectionEditing"],
    ["privacy", "settings.sectionPrivacy"],
    ["account", "settings.sectionAccounts"],
    ["updates", "settings.sectionUpdatesAbout"],
  ];
  const { locale, setLocale, t } = useI18n();
  const accounts = useAccounts();
  const [accountBusy, setAccountBusy] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cachePath, setCachePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingLocalFolder, setIsSavingLocalFolder] = useState(false);
  const [localFolderDraft, setLocalFolderDraft] = useState("");
  const [availableCameras, setAvailableCameras] = useState<string[]>([]);
  const [myPhotosRulesDraft, setMyPhotosRulesDraft] = useState<MyPhotosRule[]>([]);
  const [isSavingMyPhotosRules, setIsSavingMyPhotosRules] = useState(false);
  const [isForcingFullSync, setIsForcingFullSync] = useState(false);
  const [isQuickSyncing, setIsQuickSyncing] = useState(false);
  const [isCancellingSync, setIsCancellingSync] = useState(false);
  const [isSyncingAlbumsList, setIsSyncingAlbumsList] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const {
    forceFullSync,
    cancelSync,
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
    settingsContentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoading(true);
        const [settingsData, path, cameras] = await Promise.all([
          getSettings(),
          getCachePath(),
          getCamerasInScope({ kind: "all", filter: "all" }),
        ]);
        setSettings(settingsData);
        setLocalFolderDraft(settingsData.userLocalFolderPath ?? "");
        setMyPhotosRulesDraft(settingsData.myPhotosRules ?? []);
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

  const saveMenuItems = async (nextMenuItems: MenuItemPreference[]) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, menuItems: nextMenuItems });
    try {
      setIsSaving(true);
      const updated = await updateSettings({ ...previous, menuItems: nextMenuItems });
      setSettings(updated);
      await invalidateSettings();
    } catch (error) {
      console.error("Failed to update menu items:", error);
      setSettings(previous);
    } finally {
      setIsSaving(false);
    }
  };

  const currentMenuItems = settings?.menuItems ?? [];
  const enabledMenuItems = currentMenuItems.filter((preference) =>
    MENU_ITEMS.some((item) => item.key === preference.key),
  );

  const handleToggleMenuItem = async (key: MenuItemKey, enabled: boolean) => {
    const item = MENU_ITEMS.find((candidate) => candidate.key === key);
    if (!item) return;
    const next = enabled
      ? [...enabledMenuItems, { key, group: item.group }]
      : enabledMenuItems.filter((preference) => preference.key !== key);
    await saveMenuItems(next);
  };

  const handleMoveMenuItem = async (key: MenuItemKey, group: "main" | "library") => {
    await saveMenuItems(
      enabledMenuItems.map((preference) =>
        preference.key === key ? { ...preference, group } : preference,
      ),
    );
  };

  const handleReorderMenuItem = async (key: MenuItemKey, targetKey: MenuItemKey) => {
    if (key === targetKey) return;
    const next = [...enabledMenuItems];
    const sourceIndex = next.findIndex((preference) => preference.key === key);
    const targetIndex = next.findIndex((preference) => preference.key === targetKey);
    if (sourceIndex < 0 || targetIndex < 0 || next[sourceIndex].group !== next[targetIndex].group)
      return;
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    await saveMenuItems(next);
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

  const handlePatchMyPhotosRule = (index: number, patch: Partial<MyPhotosRule>) => {
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

  const handleCancelSync = async () => {
    try {
      setIsCancellingSync(true);
      await cancelSync();
    } catch (error) {
      console.error("Failed to cancel sync:", error);
    } finally {
      setIsCancellingSync(false);
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

  const handleSyncAlbumsList = async () => {
    try {
      setIsSyncingAlbumsList(true);
      await refreshAlbumList();
    } catch (error) {
      console.error("Failed to sync album list:", error);
    } finally {
      setIsSyncingAlbumsList(false);
    }
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
    syncStatus?.lastSyncCompletedAt !== null && syncStatus?.lastSyncCompletedAt !== undefined;
  const hasMyPhotosRuleChanges =
    JSON.stringify(myPhotosRulesDraft) !== JSON.stringify(settings?.myPhotosRules ?? []);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-100">
        <WindowHeader floating />
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-base-100">
      <WindowHeader floating />
      <div className="mx-auto flex h-full max-w-6xl flex-col px-4 pt-14">
        <div className="shrink-0 pb-4">
          <button
            type="button"
            className="btn btn-sm btn-ghost gap-2 mb-3"
            onClick={() => onNavigate?.("photos")}
          >
            <ArrowLeft size={16} />
            {t("settings.exit")}
          </button>
          <h1 className="text-3xl font-bold text-base-content">{t("settings.title")}</h1>
          <p className="text-base-content/60">{t("settings.subtitle")}</p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row md:gap-6">
          <nav className="shrink-0 md:w-56" aria-label={t("settings.sectionsAria")}>
            <ul className="menu menu-horizontal w-full flex-nowrap overflow-x-auto rounded-lg bg-base-200 md:menu-vertical md:flex-wrap">
              {sections.map(([key, labelKey]) => (
                <li key={key}>
                  <button
                    type="button"
                    className={`whitespace-nowrap ${section === key ? "menu-active" : ""}`}
                    aria-current={section === key ? "page" : undefined}
                    onClick={() => setSection(key)}
                  >
                    {t(labelKey)}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div
            ref={settingsContentRef}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-12"
            role="region"
            aria-label={t("settings.title")}
            tabIndex={0}
          >
            {section === "storage" && <StorageSettings section="storage" />}
            {section === "video" && <StorageSettings section="video" />}
            {section === "editing" && <MediaSettings section="editing" />}
            {section === "privacy" && <MediaSettings section="privacy" />}
            <div
              hidden={section !== "general"}
              className="card mb-6 border border-base-300 bg-base-100 shadow-sm"
            >
              <div className="card-body">
                <h2 className="card-title">{t("settings.languageTitle")}</h2>
                <p className="text-sm text-base-content/70 mb-3">
                  {t("settings.languageDescription")}
                </p>
                <label className="form-control w-full max-w-sm">
                  <span className="label-text mb-1">{t("settings.languageLabel")}</span>
                  <select
                    className="select select-bordered"
                    value={settings?.locale ?? locale}
                    disabled={isSaving || !settings}
                    onChange={(event) => {
                      void handleChangeLocale(event.currentTarget.value as AppLocale);
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

            <div
              hidden={section !== "sync"}
              className="card mb-6 border border-base-300 bg-base-100 shadow-sm"
            >
              <div className="card-body">
                <h2 className="card-title">{t("settings.sectionSync")}</h2>
                <p className="text-sm text-base-content/70 mb-4">{t("settings.syncDescription")}</p>

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
                    {!isForcingFullSync && !isSyncing && t("settings.forceFullSyncCta")}
                  </button>

                  {isSyncing && (
                    <button
                      type="button"
                      onClick={() => {
                        void handleCancelSync();
                      }}
                      disabled={isCancellingSync}
                      className="btn btn-outline btn-error gap-2"
                    >
                      <X size={16} />
                      {isCancellingSync
                        ? t("settings.cancellingSyncCta")
                        : t("settings.cancelSyncCta")}
                    </button>
                  )}
                </div>

                {error && (
                  <div className="alert alert-error alert-sm mt-3">
                    <span className="text-xs">{error}</span>
                  </div>
                )}

                <div className="divider my-4"></div>

                <div>
                  <button
                    type="button"
                    className="btn btn-outline btn-secondary gap-2"
                    onClick={() => {
                      void handleSyncAlbumsList();
                    }}
                    disabled={isSyncingAlbumsList}
                  >
                    <RefreshCcw size={16} />
                    {isSyncingAlbumsList
                      ? t("settings.syncAlbumsListRunning")
                      : t("settings.syncAlbumsListCta")}
                  </button>
                  <p className="mt-2 text-sm text-base-content/60">
                    {t("settings.syncAlbumsListHelp")}
                  </p>
                </div>
              </div>
            </div>

            {/* Navigation Menu Settings */}
            <div
              hidden={section !== "navigation"}
              className="card mb-6 border border-base-300 bg-base-100 shadow-sm"
            >
              <div className="card-body">
                <h2 className="card-title">{t("settings.sectionNavigation")}</h2>
                <p className="text-sm text-base-content/70 mb-2">
                  {t("settings.navigationDescription")}
                </p>
                <div className="space-y-5">
                  {(["main", "library"] as const).map((group) => {
                    const groupItems = enabledMenuItems.filter(
                      (preference) => preference.group === group,
                    );
                    return (
                      <section
                        key={group}
                        className="space-y-1 rounded-box border border-base-300 p-3"
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          const dragged = event.dataTransfer.getData(
                            "text/menu-item",
                          ) as MenuItemKey;
                          const target = event.currentTarget.getAttribute(
                            "data-drop-key",
                          ) as MenuItemKey | null;
                          if (target) void handleReorderMenuItem(dragged, target);
                          else if (dragged && groupItems.length)
                            void handleReorderMenuItem(
                              dragged,
                              groupItems[groupItems.length - 1].key as MenuItemKey,
                            );
                        }}
                      >
                        <h3 className="px-2 text-sm font-semibold">
                          {t(
                            group === "main"
                              ? "settings.navigationMain"
                              : "settings.navigationLibrary",
                          )}
                        </h3>
                        {groupItems.map((preference, index) => {
                          const item = MENU_ITEMS.find(
                            (candidate) => candidate.key === preference.key,
                          );
                          if (!item) return null;
                          const Icon = item.icon;
                          return (
                            <div
                              key={item.key}
                              className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 hover:bg-base-200"
                              draggable={!isSaving}
                              onDragStart={(event) =>
                                event.dataTransfer.setData("text/menu-item", item.key)
                              }
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                const dragged = event.dataTransfer.getData(
                                  "text/menu-item",
                                ) as MenuItemKey;
                                void handleReorderMenuItem(dragged, item.key);
                              }}
                              data-drop-key={item.key}
                            >
                              <GripVertical
                                size={16}
                                className="shrink-0 text-base-content/40"
                                aria-hidden="true"
                              />
                              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                                <input
                                  type="checkbox"
                                  className="checkbox checkbox-primary"
                                  checked
                                  onChange={(event) =>
                                    void handleToggleMenuItem(item.key, event.currentTarget.checked)
                                  }
                                  disabled={isSaving}
                                />
                                <Icon size={16} className="shrink-0 text-base-content/70" />
                                <span className="label-text">{t(item.labelKey)}</span>
                              </label>
                              <select
                                className="select select-sm w-52 shrink-0 pr-8"
                                aria-label={t("settings.moveMenuItem", { item: t(item.labelKey) })}
                                value={group}
                                disabled={isSaving}
                                onChange={(event) =>
                                  void handleMoveMenuItem(
                                    item.key,
                                    event.currentTarget.value as "main" | "library",
                                  )
                                }
                              >
                                <option value="main">{t("settings.navigationMain")}</option>
                                <option value="library">{t("settings.navigationLibrary")}</option>
                              </select>
                              <button
                                type="button"
                                className="btn btn-ghost btn-xs btn-square"
                                aria-label={t("settings.moveMenuItemUp", {
                                  item: t(item.labelKey),
                                })}
                                disabled={isSaving || index === 0}
                                onClick={() =>
                                  void handleReorderMenuItem(
                                    item.key,
                                    groupItems[index - 1]?.key as MenuItemKey,
                                  )
                                }
                              >
                                <ArrowUp size={15} />
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-xs btn-square"
                                aria-label={t("settings.moveMenuItemDown", {
                                  item: t(item.labelKey),
                                })}
                                disabled={isSaving || index === groupItems.length - 1}
                                onClick={() =>
                                  void handleReorderMenuItem(
                                    groupItems[index + 1]?.key as MenuItemKey,
                                    item.key,
                                  )
                                }
                              >
                                <ArrowDown size={15} />
                              </button>
                            </div>
                          );
                        })}
                        {groupItems.length === 0 && (
                          <p className="px-2 py-2 text-sm text-base-content/60">
                            {t("settings.navigationEmpty")}
                          </p>
                        )}
                      </section>
                    );
                  })}
                  <div className="space-y-1">
                    <h3 className="px-2 text-sm font-semibold">{t("settings.navigationHidden")}</h3>
                    {MENU_ITEMS.filter(
                      (item) => !enabledMenuItems.some((preference) => preference.key === item.key),
                    ).map(({ key, labelKey, icon: Icon }) => (
                      <label key={key} className="label cursor-pointer justify-start gap-3">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-primary"
                          checked={false}
                          onChange={(event) =>
                            void handleToggleMenuItem(key, event.currentTarget.checked)
                          }
                          disabled={isSaving || !settings}
                        />
                        <Icon size={16} className="shrink-0 text-base-content/70" />
                        <span className="label-text">{t(labelKey)}</span>
                      </label>
                    ))}
                  </div>
                  <fieldset className="fieldset max-w-sm">
                    <legend className="fieldset-legend">{t("settings.recentAlbumsLimit")}</legend>
                    <select
                      className="select w-full"
                      value={settings?.recentAlbumsLimit ?? 5}
                      disabled={!settings || isSaving}
                      onChange={async (event) => {
                        if (!settings) return;
                        const previous = settings;
                        const next = {
                          ...settings,
                          recentAlbumsLimit: Number(event.currentTarget.value),
                        };
                        setSettings(next);
                        try {
                          setIsSaving(true);
                          const updated = await updateSettings(next);
                          setSettings(updated);
                          await invalidateSettings();
                        } catch (error) {
                          console.error("Failed to update recent albums preference:", error);
                          setSettings(previous);
                        } finally {
                          setIsSaving(false);
                        }
                      }}
                    >
                      {[3, 5, 10, 20].map((count) => (
                        <option key={count} value={count}>
                          {t("settings.recentAlbumsCount", { count })}
                        </option>
                      ))}
                    </select>
                  </fieldset>
                </div>
              </div>
            </div>

            {/* Live Photo Settings */}
            <div
              hidden={section !== "general"}
              className="card mb-6 border border-base-300 bg-base-100 shadow-sm"
            >
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
                              <option value="">{t("settings.myPhotosSelectCamera")}</option>
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
                    {isSavingMyPhotosRules ? t("settings.saving") : t("settings.myPhotosSaveRules")}
                  </button>
                </div>
              </div>
            </div>

            {/* Live Photo Settings */}
            <div
              hidden={section !== "general"}
              className="card mb-6 border border-base-300 bg-base-100 shadow-sm"
            >
              <div className="card-body">
                <h2 className="card-title">{t("settings.sectionLivePhotos")}</h2>{" "}
                <div className="form-control">
                  <label className="label cursor-pointer">
                    <span className="label-text">{t("settings.livePhotosAutoplay")}</span>
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
            <div
              hidden={section !== "storage"}
              className="card mb-6 border border-base-300 bg-base-100 shadow-sm"
            >
              <div className="card-body">
                <div className="form-control mb-4">
                  <label className="label">
                    <span className="label-text font-medium">{t("settings.localFolderLabel")}</span>
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
                      {isSavingLocalFolder ? t("settings.saving") : t("settings.save")}
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
                        void openFolderInFileExplorer(settings.userLocalFolderPath).catch(
                          (error) => {
                            console.error("Failed to open local folder:", error);
                            window.alert(t("settings.failedOpenLocalFolder"));
                          },
                        );
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
                    <span className="label-text font-medium">{t("settings.cacheLocation")}</span>
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
                          void openFolderInFileExplorer(cachePath).catch((error) => {
                            console.error("Failed to open cache folder:", error);
                            window.alert(t("settings.failedOpenCacheFolder"));
                          });
                        }
                      }}
                    >
                      <FolderOpen size={16} />
                      {t("settings.open")}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Account */}
            <div
              hidden={section !== "account"}
              className="card mb-6 border border-base-300 bg-base-100 shadow-sm"
            >
              <div className="card-body">
                <h2 className="card-title">{t("settings.sectionAccount")}</h2>
                <p className="text-sm text-base-content/70 mb-4">
                  {t("settings.accountDescription")}
                </p>

                {accounts.accounts.length > 0 ? (
                  <div className="mb-4">
                    <p className="mb-2 text-sm font-semibold text-base-content">
                      {t("account.accountsTitle")}
                    </p>
                    <ul className="space-y-2">
                      {accounts.accounts.map((account) => {
                        const label = account.userName || account.userEmail || account.userId;
                        return (
                          <li
                            key={account.id}
                            className="flex items-center gap-3 rounded-box border border-base-300 bg-base-200 px-3 py-2"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="m-0 truncate text-sm font-medium text-base-content">
                                {label}
                              </p>
                              <p className="m-0 truncate text-xs text-base-content/50">
                                {account.serverUrl}
                              </p>
                            </div>
                            {account.isPrimary ? (
                              <span className="badge badge-primary gap-1">
                                <Check size={12} />
                                {t("account.primaryBadge")}
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-sm btn-outline"
                                disabled={accountBusy}
                                onClick={async () => {
                                  setAccountBusy(true);
                                  try {
                                    await accounts.setPrimary(account.id);
                                    window.location.reload();
                                  } catch (err) {
                                    console.error("[accounts] set primary failed", err);
                                    setAccountBusy(false);
                                  }
                                }}
                              >
                                {t("account.makePrimary")}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="mt-2 text-xs text-base-content/60">{t("account.restartHint")}</p>
                    <AccountsBaseDirectorySettings accounts={accounts.accounts} />
                  </div>
                ) : null}

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
            <div
              hidden={section !== "updates"}
              className="card mb-6 border border-base-300 bg-base-100 shadow-sm"
            >
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
                    disabled={appUpdate.status === "checking" || appUpdate.status === "downloading"}
                    className="btn btn-outline gap-2"
                  >
                    <Download size={16} />
                    {t("settings.checkForUpdates")}
                  </button>
                )}
              </div>
            </div>

            {/* About */}
            <div
              hidden={section !== "updates"}
              className="card border border-base-300 bg-base-100 shadow-sm"
            >
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
      </div>
    </div>
  );
}

function toLocalDateInputValue(date: Date): string {
  const timezoneAdjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return timezoneAdjusted.toISOString().slice(0, 10);
}

function normalizeMyPhotosRules(rules: MyPhotosRule[]): MyPhotosRule[] {
  return rules
    .map((rule) => {
      const startDate = rule.startDate.trim();
      const camera = rule.camera.trim();
      const endDateCurrent = rule.endDateCurrent === true;
      const endDate = endDateCurrent ? null : (rule.endDate ?? "").trim() || null;

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
