import { useEffect, useMemo, useState } from "react";
import { authenticate } from "./api/tauri";
import { useAssets } from "./hooks/useAssets";
import { LoginScreen } from "./components/Auth/LoginScreen";
import { PhotoGrid } from "./components/PhotoGrid/PhotoGrid";

type Session = {
  serverUrl: string;
  apiKey: string;
};

const AUTH_STORAGE_KEY = "immichLocalApp.auth";

function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      typeof parsed.serverUrl !== "string" ||
      typeof parsed.apiKey !== "string" ||
      !parsed.serverUrl ||
      !parsed.apiKey
    ) {
      return null;
    }

    return {
      serverUrl: parsed.serverUrl,
      apiKey: parsed.apiKey,
    };
  } catch {
    return null;
  }
}

function persistSession(session: Session) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

function clearPersistedSession() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [storedSession] = useState<Session | null>(() => readStoredSession());
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(
    Boolean(storedSession),
  );

  const assetsQuery = useAssets(Boolean(session));

  const assets = useMemo(
    () => assetsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [assetsQuery.data],
  );

  useEffect(() => {
    if (!storedSession) {
      return;
    }

    const sessionToRestore = storedSession;

    let cancelled = false;

    async function restoreSession() {
      setIsAuthenticating(true);
      setAuthError(null);

      try {
        await authenticate(sessionToRestore.serverUrl, sessionToRestore.apiKey);
        if (!cancelled) {
          setSession(sessionToRestore);
        }
      } catch {
        clearPersistedSession();
      } finally {
        if (!cancelled) {
          setIsAuthenticating(false);
          setIsRestoringSession(false);
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, [storedSession]);

  async function handleLogin(input: { serverUrl: string; apiKey: string }) {
    setAuthError(null);
    setIsAuthenticating(true);

    try {
      await authenticate(input.serverUrl, input.apiKey);
      const nextSession = { serverUrl: input.serverUrl, apiKey: input.apiKey };
      persistSession(nextSession);
      setSession(nextSession);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown authentication error";
      setAuthError(message);
      setSession(null);
      clearPersistedSession();
    } finally {
      setIsAuthenticating(false);
    }
  }

  if (isRestoringSession) {
    return (
      <main className="page">
        <section className="card">
          <h1>Immich Local App</h1>
          <p className="subtitle">Restoring previous session...</p>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="page">
        <LoginScreen
          onSubmit={handleLogin}
          initialServerUrl={storedSession?.serverUrl}
          initialApiKey={storedSession?.apiKey}
          isLoading={isAuthenticating}
          error={authError}
        />
      </main>
    );
  }

  return (
    <main className="page">
      <section className="toolbar">
        <h1>Immich Local App</h1>
        <p>Connected to {session.serverUrl}</p>
      </section>

      {assetsQuery.isError ? (
        <p className="error">{(assetsQuery.error as Error).message}</p>
      ) : (
        <PhotoGrid
          assets={assets}
          isFetching={assetsQuery.isFetchingNextPage}
          hasNextPage={Boolean(assetsQuery.hasNextPage)}
          onLoadMore={() => {
            void assetsQuery.fetchNextPage();
          }}
        />
      )}
    </main>
  );
}
