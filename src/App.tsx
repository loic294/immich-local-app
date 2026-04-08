import { useState } from "react";
import { useSession } from "./hooks/useSession";
import { LoginScreen } from "./components/Auth/LoginScreen";
import { LoadingScreen } from "./components/Layout/LoadingScreen";
import type { AppPage } from "./components/Layout/Sidebar";
import { AlbumsPage } from "./pages/AlbumsPage";
import { FoldersPage } from "./pages/FoldersPage";
import { PhotosPage } from "./pages/PhotosPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const [activePage, setActivePage] = useState<AppPage>("photos");
  const {
    session,
    error,
    isAuthenticating,
    isRestoringSession,
    login,
    logout,
  } = useSession();

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

  if (activePage === "settings") {
    return <SettingsPage onNavigate={setActivePage} onLogout={logout} />;
  }

  return <PhotosPage session={session} onNavigate={setActivePage} />;
}
