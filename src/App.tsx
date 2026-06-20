import { useState, useEffect, useRef } from "react";
import { useSession } from "./hooks/useSession";
import { useSyncStatus } from "./hooks/useSyncStatus";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useConnection } from "./hooks/useConnection";
import { ConnectionProvider } from "./hooks/connectionContext";
import { ServerUrlScreen } from "./components/Auth/ServerUrlScreen";
import { LoginScreen } from "./components/Auth/LoginScreen";
import { LoadingScreen } from "./components/Layout/LoadingScreen";
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
  const hasTriggeredResume = useRef(false);
  const hasQuickCheckedOnBoot = useRef(false);
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

  const { syncStatus, startSync, checkForNewAssets } = useSyncStatus();

  // Local-first connection monitor: probe the server, drive offline UI, and
  // replay queued mutations + re-check for new assets when connectivity returns.
  const { isOnline, pendingCount } = useConnection({
    enabled: !!session && !isRestoringSession,
    initialOnline: !restoredOffline,
    onReconnect: () => {
      void checkForNewAssets();
    },
  });

  const appUpdate = useAppUpdate();
  const hasCheckedForUpdate = useRef(false);

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
    </ConnectionProvider>
  );
}
