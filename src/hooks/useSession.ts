import { useEffect, useState } from "react";
import { authenticate, restoreSession, logoutFromServer } from "../api/tauri";

export type Session = {
  serverUrl: string;
  apiKey: string;
  userId: string;
  userName: string;
};

export type UseSessionReturn = {
  session: Session | null;
  error: string | null;
  isAuthenticating: boolean;
  isRestoringSession: boolean;
  login: (input: { serverUrl: string; apiKey: string }) => Promise<void>;
  logout: () => void;
};

export function useSession(): UseSessionReturn {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(true);

  // Restore session from DB on mount
  useEffect(() => {
    let cancelled = false;

    async function tryRestoreSession() {
      try {
        const response = await restoreSession();
        if (!cancelled && response) {
          setSession({
            serverUrl: response.serverUrl,
            apiKey: "",
            userId: response.userId,
            userName: response.userName ?? response.userId,
          });
        }
      } catch {
        // No stored session or restore failed — stay on login screen
      } finally {
        if (!cancelled) {
          setIsRestoringSession(false);
        }
      }
    }

    void tryRestoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  async function login(input: { serverUrl: string; apiKey: string }) {
    setError(null);
    setIsAuthenticating(true);

    try {
      const authResponse = await authenticate(input.serverUrl, input.apiKey);
      setSession({
        serverUrl: input.serverUrl,
        apiKey: input.apiKey,
        userId: authResponse.userId,
        userName: authResponse.userName ?? authResponse.userId,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown authentication error";
      setError(message);
      setSession(null);
    } finally {
      setIsAuthenticating(false);
    }
  }

  function logout() {
    setSession(null);
    setError(null);
    logoutFromServer().catch((err) =>
      console.error("Failed to clear server session:", err),
    );
  }

  return {
    session,
    error,
    isAuthenticating,
    isRestoringSession,
    login,
    logout,
  };
}
