import { useState, useEffect, useRef } from "react";
import { useSession } from "./hooks/useSession";
import { useSyncStatus } from "./hooks/useSyncStatus";
import { LoginScreen } from "./components/Auth/LoginScreen";
import { LoadingScreen } from "./components/Layout/LoadingScreen";
import type { AppPage } from "./components/Layout/Sidebar";
import { AlbumsPage } from "./pages/AlbumsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { FoldersPage } from "./pages/FoldersPage";
import { PhotosPage } from "./pages/PhotosPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const [activePage, setActivePage] = useState<AppPage>("photos");
  const hasTriggeredResume = useRef(false);
  const {
    session,
    error,
    isAuthenticating,
    isRestoringSession,
    login,
    logout,
  } = useSession();

  const { syncStatus, startSync, checkForNewAssets } = useSyncStatus();

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
    return (
      <main className="min-h-screen bg-base-200 p-6">
        <LoginScreen
          onSubmit={login}
          isLoading={isAuthenticating}
          error={error}
        />
      </main>
    );
  }

  if (activePage === "albums") {
    return <AlbumsPage session={session} onNavigate={setActivePage} />;
  }

  if (activePage === "folders") {
    return <FoldersPage session={session} onNavigate={setActivePage} />;
  }

  if (activePage === "calendar") {
    return <CalendarPage session={session} onNavigate={setActivePage} />;
  }

  if (activePage === "settings") {
    return <SettingsPage onNavigate={setActivePage} onLogout={logout} />;
  }

  return <PhotosPage session={session} onNavigate={setActivePage} />;
}
