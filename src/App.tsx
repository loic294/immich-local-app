import { useState, useEffect, useRef } from "react";
import { useSession } from "./hooks/useSession";
import { useSyncStatus } from "./hooks/useSyncStatus";
import { ServerUrlScreen } from "./components/Auth/ServerUrlScreen";
import { LoginScreen } from "./components/Auth/LoginScreen";
import { LoadingScreen } from "./components/Layout/LoadingScreen";
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
  const {
    session,
    error,
    isAuthenticating,
    isRestoringSession,
    serverUrl,
    setServerUrl,
    initiateOAuth,
    completeOAuthWithCode,
    login,
    logout,
  } = useSession();

  const { syncStatus, startSync, checkForNewAssets } = useSyncStatus();

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
      syncStatus?.isSyncing &&
      !hasTriggeredResume.current
    ) {
      hasTriggeredResume.current = true;
      void startSync();
    }

    if (!syncStatus?.isSyncing) {
      hasTriggeredResume.current = false;
    }
  }, [session, isRestoringSession, syncStatus?.isSyncing, startSync]);

  // Auto-start sync if never done before and user is authenticated
  useEffect(() => {
    if (
      session &&
      !isRestoringSession &&
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
    syncStatus?.lastSyncCompletedAt,
    syncStatus?.isSyncing,
    startSync,
  ]);

  // Auto-check for new assets on app launch if sync was already done
  useEffect(() => {
    if (
      session &&
      !isRestoringSession &&
      syncStatus &&
      syncStatus.lastSyncCompletedAt &&
      !syncStatus.isSyncing &&
      !syncStatus.lastCheckedAt
    ) {
      // First app launch after sync completed - check for new assets
      void checkForNewAssets();
    }
  }, [
    session,
    isRestoringSession,
    syncStatus?.lastSyncCompletedAt,
    syncStatus?.isSyncing,
    syncStatus?.lastCheckedAt,
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
          onBack={() => {
            setShowServerUrlScreen(true);
          }}
          isLoading={isAuthenticating}
          error={error}
        />
      </main>
    );
  }

  if (activePage === "albums") {
    return (
      <AlbumsPage
        session={session}
        onNavigate={setActivePage}
        onLogout={logout}
      />
    );
  }

  if (activePage === "folders") {
    return (
      <FoldersPage
        session={session}
        onNavigate={setActivePage}
        onLogout={logout}
      />
    );
  }

  if (activePage === "calendar") {
    return (
      <CalendarPage
        session={session}
        onNavigate={setActivePage}
        onLogout={logout}
      />
    );
  }

  if (activePage === "settings") {
    return <SettingsPage onNavigate={setActivePage} onLogout={logout} />;
  }

  if (activePage === "favorites") {
    return (
      <FavoritesPage
        session={session}
        onNavigate={setActivePage}
        onLogout={logout}
      />
    );
  }

  if (activePage === "deleted") {
    return (
      <DeletedPage
        session={session}
        onNavigate={setActivePage}
        onLogout={logout}
      />
    );
  }

  return (
    <PhotosPage
      session={session}
      onNavigate={setActivePage}
      onLogout={logout}
    />
  );
}
