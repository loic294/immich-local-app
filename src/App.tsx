import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "./hooks/useSession";
import { useSyncStatus } from "./hooks/useSyncStatus";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useConnection } from "./hooks/useConnection";
import { ConnectionProvider } from "./hooks/connectionContext";
import {
  applySavedLocalFileChanges,
  getSavedLocalFileChanges,
  refreshAlbumList,
  scanSavedLocalFiles,
} from "./api/tauri";
import type { SavedLocalFileChange } from "./types";
import { ServerUrlScreen } from "./components/Auth/ServerUrlScreen";
import { LoginScreen } from "./components/Auth/LoginScreen";
import { LoadingScreen } from "./components/Layout/LoadingScreen";
import { LocalSavedFileChangesModal } from "./components/Layout/LocalSavedFileChangesModal";
import { UpdateNotifier } from "./components/Layout/UpdateNotifier";
import type { AppPage } from "./components/Layout/Sidebar";
import { AlbumsPage } from "./pages/AlbumsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { FoldersPage } from "./pages/FoldersPage";
import { PhotosPage } from "./pages/PhotosPage";
import { SettingsPage } from "./pages/SettingsPage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { DeletedPage } from "./pages/DeletedPage";

export function App() {
  const [activePage, setActivePage] = useState<AppPage>("photos");
  const [showServerUrlScreen, setShowServerUrlScreen] = useState(false);
  const [applyProgressTotal, setApplyProgressTotal] = useState(0);
  const [applyProgressDone, setApplyProgressDone] = useState(0);
  const [localFileApplyErrors, setLocalFileApplyErrors] = useState<string[]>(
    [],
  );
  const [localFileChanges, setLocalFileChanges] = useState<
    SavedLocalFileChange[]
  >([]);
  const [showLocalFileChangesModal, setShowLocalFileChangesModal] =
    useState(false);
  const [isApplyingLocalFileChanges, setIsApplyingLocalFileChanges] =
    useState(false);
  const hasTriggeredResume = useRef(false);
  const hasQuickCheckedOnBoot = useRef(false);
  const hasSyncedAlbumListOnBoot = useRef(false);
  const hasScannedLocalFilesOnBoot = useRef(false);
  const lastLocalFileScanAtRef = useRef(0);
  const {
    session,
    error,
    isAuthenticating,
    isRestoringSession,
    restoredOffline,
    serverUrl,
    setServerUrl,
    initiateOAuth,
    completeOAuthWithCode,
    login,
    loginWithPassword,
    logout,
  } = useSession();
  const queryClient = useQueryClient();

  const { syncStatus, startSync, checkForNewAssets } = useSyncStatus();

  // Local-first connection monitor: probe the server, drive offline UI, and
  // replay queued mutations + re-check for new assets when connectivity returns.
  const { isOnline, pendingCount } = useConnection({
    enabled: !!session && !isRestoringSession,
    initialOnline: !restoredOffline,
    onReconnect: () => {
      void checkForNewAssets();
      void refreshAlbumList().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.startsWith("offline:")) {
          console.warn("[app] album list refresh on reconnect failed", err);
        }
      });
    },
  });

  const appUpdate = useAppUpdate();
  const hasCheckedForUpdate = useRef(false);

  const LOCAL_FILE_SCAN_THROTTLE_MS = 5 * 60 * 1000;

  async function runLocalSavedFilesScan(reason: "startup" | "foreground") {
    if (!session || isRestoringSession) {
      return;
    }

    const now = Date.now();
    if (reason === "foreground") {
      const elapsed = now - lastLocalFileScanAtRef.current;
      if (elapsed < LOCAL_FILE_SCAN_THROTTLE_MS) {
        return;
      }
    }

    lastLocalFileScanAtRef.current = now;

    try {
      await scanSavedLocalFiles();
      const unresolved = await getSavedLocalFileChanges();
      setLocalFileChanges(unresolved);
      setShowLocalFileChangesModal(unresolved.length > 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.startsWith("offline:")) {
        console.warn("[app] local saved files scan failed", err);
      }
    }
  }

  // Check for app updates once on launch, then silently download any update.
  useEffect(() => {
    if (hasCheckedForUpdate.current) {
      return;
    }
    hasCheckedForUpdate.current = true;
    void appUpdate.checkForUpdate(true);
  }, [appUpdate]);

  // If session is restored but serverUrl is still null, we're in OAuth step
  useEffect(() => {
    if (session && serverUrl) {
      setShowServerUrlScreen(false);
    } else if (!session && !serverUrl && !isRestoringSession) {
      setShowServerUrlScreen(true);
    }
  }, [session, serverUrl, isRestoringSession]);

  // Resume unfinished sync on app launch (after app restart/crash)
  useEffect(() => {
    if (
      session &&
      !isRestoringSession &&
      isOnline === true &&
      syncStatus?.isSyncing &&
      !hasTriggeredResume.current
    ) {
      hasTriggeredResume.current = true;
      void startSync();
    }

    if (!syncStatus?.isSyncing) {
      hasTriggeredResume.current = false;
    }
  }, [session, isRestoringSession, isOnline, syncStatus?.isSyncing, startSync]);

  // Auto-start sync if never done before and user is authenticated
  useEffect(() => {
    if (
      session &&
      !isRestoringSession &&
      isOnline === true &&
      syncStatus &&
      !syncStatus.lastSyncCompletedAt &&
      !syncStatus.isSyncing
    ) {
      // First sync - start it automatically
      void startSync();
    }
  }, [
    session,
    isRestoringSession,
    isOnline,
    syncStatus?.lastSyncCompletedAt,
    syncStatus?.isSyncing,
    startSync,
  ]);

  // Quick sync on boot once per app launch: the All Photos timeline always
  // checks for recent new content when the app starts (after the initial full
  // sync has completed). This is a cheap "recent only" check, not a full
  // re-scan. See sync.instructions.md.
  useEffect(() => {
    if (
      session &&
      !isRestoringSession &&
      isOnline === true &&
      !hasSyncedAlbumListOnBoot.current
    ) {
      hasSyncedAlbumListOnBoot.current = true;
      void refreshAlbumList().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.startsWith("offline:")) {
          console.warn("[app] startup album list refresh failed", err);
        }
      });
    }
  }, [session, isRestoringSession, isOnline]);

  useEffect(() => {
    if (!session) {
      hasSyncedAlbumListOnBoot.current = false;
      hasScannedLocalFilesOnBoot.current = false;
      lastLocalFileScanAtRef.current = 0;
      setLocalFileChanges([]);
      setLocalFileApplyErrors([]);
      setShowLocalFileChangesModal(false);
    }
  }, [session]);

  useEffect(() => {
    if (session && !isRestoringSession && !hasScannedLocalFilesOnBoot.current) {
      hasScannedLocalFilesOnBoot.current = true;
      void runLocalSavedFilesScan("startup");
    }
  }, [session, isRestoringSession]);

  useEffect(() => {
    if (!session || isRestoringSession) {
      return;
    }

    const handleForeground = () => {
      if (document.visibilityState === "visible") {
        void runLocalSavedFilesScan("foreground");
      }
    };

    const handleFocus = () => {
      void runLocalSavedFilesScan("foreground");
    };

    document.addEventListener("visibilitychange", handleForeground);
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleForeground);
      window.removeEventListener("focus", handleFocus);
    };
  }, [session, isRestoringSession]);

  async function applySelectedLocalFileChanges(changeIds: number[]) {
    if (changeIds.length === 0) {
      return;
    }

    setApplyProgressTotal(changeIds.length);
    setApplyProgressDone(0);
    setIsApplyingLocalFileChanges(true);
    setLocalFileApplyErrors([]);
    try {
      const result = await applySavedLocalFileChanges(changeIds);
      setApplyProgressDone(result.appliedCount);
      setLocalFileApplyErrors(result.errors);

      if (result.failedCount > 0) {
        console.warn(
          "[app] apply local file changes completed with failures",
          result,
        );
      }

      // Refresh active data sources so album/photo-grid state reflects the
      // applied changes without remounting the whole page (prevents flicker).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["albums"] }),
        queryClient.invalidateQueries({ queryKey: ["assets"] }),
        queryClient.invalidateQueries({ queryKey: ["album-assets-paged"] }),
        queryClient.invalidateQueries({ queryKey: ["folder-assets-paged"] }),
        queryClient.invalidateQueries({ queryKey: ["calendar-assets-paged"] }),
      ]);
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["albums"], type: "active" }),
        queryClient.refetchQueries({ queryKey: ["assets"], type: "active" }),
        queryClient.refetchQueries({
          queryKey: ["album-assets-paged"],
          type: "active",
        }),
        queryClient.refetchQueries({
          queryKey: ["folder-assets-paged"],
          type: "active",
        }),
        queryClient.refetchQueries({
          queryKey: ["calendar-assets-paged"],
          type: "active",
        }),
      ]);

      const unresolved = await getSavedLocalFileChanges();
      setLocalFileChanges(unresolved);
      setShowLocalFileChangesModal(unresolved.length > 0);
    } finally {
      setIsApplyingLocalFileChanges(false);
      window.setTimeout(() => {
        setApplyProgressTotal(0);
        setApplyProgressDone(0);
      }, 600);
    }
  }

  useEffect(() => {
    if (
      session &&
      !isRestoringSession &&
      isOnline === true &&
      syncStatus &&
      syncStatus.lastSyncCompletedAt &&
      !syncStatus.isSyncing &&
      !hasQuickCheckedOnBoot.current
    ) {
      hasQuickCheckedOnBoot.current = true;
      void checkForNewAssets();
    }
  }, [
    session,
    isRestoringSession,
    isOnline,
    syncStatus?.lastSyncCompletedAt,
    syncStatus?.isSyncing,
    syncStatus,
    checkForNewAssets,
  ]);

  if (isRestoringSession) {
    return <LoadingScreen />;
  }

  if (!session) {
    if (showServerUrlScreen && !serverUrl) {
      return (
        <main className="min-h-screen bg-base-200 p-6">
          <ServerUrlScreen
            onSubmit={async (url) => {
              await setServerUrl(url);
              setShowServerUrlScreen(false);
            }}
            isLoading={isAuthenticating}
            error={error}
          />
        </main>
      );
    }

    return (
      <main className="min-h-screen bg-base-200 p-6">
        <LoginScreen
          serverUrl={serverUrl ?? "http://localhost:2283"}
          onAuthorize={initiateOAuth}
          onCodeSubmit={completeOAuthWithCode}
          onApiKeySubmit={async (apiKey) => {
            await login({
              serverUrl: serverUrl ?? "http://localhost:2283",
              apiKey,
            });
          }}
          onPasswordSubmit={async (email, password) => {
            await loginWithPassword({
              serverUrl: serverUrl ?? "http://localhost:2283",
              email,
              password,
            });
          }}
          onBack={() => {
            setShowServerUrlScreen(true);
          }}
          isLoading={isAuthenticating}
          error={error}
        />
      </main>
    );
  }

  const pageContent = (() => {
    switch (activePage) {
      case "albums":
        return (
          <AlbumsPage
            session={session}
            onNavigate={setActivePage}
            onLogout={logout}
          />
        );
      case "folders":
        return (
          <FoldersPage
            session={session}
            onNavigate={setActivePage}
            onLogout={logout}
          />
        );
      case "calendar":
        return (
          <CalendarPage
            session={session}
            onNavigate={setActivePage}
            onLogout={logout}
          />
        );
      case "settings":
        return <SettingsPage onNavigate={setActivePage} onLogout={logout} />;
      case "favorites":
        return (
          <FavoritesPage
            session={session}
            onNavigate={setActivePage}
            onLogout={logout}
          />
        );
      case "deleted":
        return (
          <DeletedPage
            session={session}
            onNavigate={setActivePage}
            onLogout={logout}
          />
        );
      default:
        return (
          <PhotosPage
            session={session}
            onNavigate={setActivePage}
            onLogout={logout}
          />
        );
    }
  })();

  return (
    <ConnectionProvider value={{ isOnline, pendingCount }}>
      {pageContent}
      <UpdateNotifier update={appUpdate} />
      <LocalSavedFileChangesModal
        open={showLocalFileChangesModal}
        changes={localFileChanges}
        isApplying={isApplyingLocalFileChanges}
        applyErrors={localFileApplyErrors}
        onApplyAll={async () => {
          await applySelectedLocalFileChanges(
            localFileChanges.map((item) => item.id),
          );
        }}
        onApplySelected={applySelectedLocalFileChanges}
        onCancel={() => setShowLocalFileChangesModal(false)}
      />
      {isApplyingLocalFileChanges ? (
        <div className="fixed bottom-4 right-4 z-50 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg">
          <p className="text-xs font-medium text-base-content mb-2">
            Applying local changes...
          </p>
          <progress
            className="progress progress-primary progress-sm w-full"
            value={applyProgressDone}
            max={Math.max(applyProgressTotal, 1)}
          ></progress>
          <p className="mt-1 text-[11px] text-base-content/70">
            {applyProgressDone} / {applyProgressTotal}
          </p>
        </div>
      ) : null}
    </ConnectionProvider>
  );
}
