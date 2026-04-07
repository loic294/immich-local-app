import { useEffect, useState } from "react";
import { authenticate } from "../api/tauri";

export type Session = {
  serverUrl: string;
  apiKey: string;
  userId: string;
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
      typeof parsed.apiKey !== "string"
    ) {
      return null;
    }

    if (!parsed.serverUrl || !parsed.apiKey) {
      return null;
    }

    return {
      serverUrl: parsed.serverUrl,
      apiKey: parsed.apiKey,
      userId: typeof parsed.userId === "string" ? parsed.userId : "",
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

export type UseSessionReturn = {
  session: Session | null;
  storedSession: Session | null;
  error: string | null;
  isAuthenticating: boolean;
  isRestoringSession: boolean;
  login: (input: { serverUrl: string; apiKey: string }) => Promise<void>;
  logout: () => void;
};

export function useSession(): UseSessionReturn {
  const [session, setSession] = useState<Session | null>(null);
  const [storedSession] = useState<Session | null>(() => readStoredSession());
  const [error, setError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(
    Boolean(storedSession),
  );

  // Restore session on mount
  useEffect(() => {
    if (!storedSession) {
      return;
    }

    const sessionToRestore = storedSession;
    let cancelled = false;

    async function restoreSession() {
      setIsAuthenticating(true);
      setError(null);

      try {
        const authResponse = await authenticate(
          sessionToRestore.serverUrl,
          sessionToRestore.apiKey,
        );
        if (!cancelled) {
          setSession({
            serverUrl: sessionToRestore.serverUrl,
            apiKey: sessionToRestore.apiKey,
            userId: authResponse.userId,
          });
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

  async function login(input: { serverUrl: string; apiKey: string }) {
    setError(null);
    setIsAuthenticating(true);

    try {
      const authResponse = await authenticate(input.serverUrl, input.apiKey);
      const nextSession = {
        serverUrl: input.serverUrl,
        apiKey: input.apiKey,
        userId: authResponse.userId,
      };
      persistSession(nextSession);
      setSession(nextSession);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown authentication error";
      setError(message);
      setSession(null);
      clearPersistedSession();
    } finally {
      setIsAuthenticating(false);
    }
  }

  function logout() {
    setSession(null);
    clearPersistedSession();
    setError(null);
  }

  return {
    session,
    storedSession,
    error,
    isAuthenticating,
    isRestoringSession,
    login,
    logout,
  };
}
