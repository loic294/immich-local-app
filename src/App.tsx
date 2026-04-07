import { useSession } from "./hooks/useSession";
import { LoginScreen } from "./components/Auth/LoginScreen";
import { LoadingScreen } from "./components/Layout/LoadingScreen";
import { PhotosPage } from "./pages/PhotosPage";

export function App() {
  const {
    session,
    storedSession,
    error,
    isAuthenticating,
    isRestoringSession,
    login,
  } = useSession();

  if (isRestoringSession) {
    return <LoadingScreen />;
  }

  if (!session) {
    return (
      <main className="min-h-screen bg-base-200 p-6">
        <LoginScreen
          onSubmit={login}
          initialServerUrl={storedSession?.serverUrl}
          initialApiKey={storedSession?.apiKey}
          isLoading={isAuthenticating}
          error={error}
        />
      </main>
    );
  }

  return <PhotosPage session={session} />;
}
