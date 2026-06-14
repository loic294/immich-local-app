import { useEffect, useRef, useState } from "react";
import {
  authenticate,
  restoreSession,
  logoutFromServer,
  clearWebviewBrowsingData,
  getOAuthAuthorizationUrl,
  completeOAuthFlow,
  openUrl,
} from "../api/tauri";

export type Session = {
  serverUrl: string;
  accessToken: string;
  userId: string;
  userName: string;
};

export type UseSessionReturn = {
  session: Session | null;
  error: string | null;
  isAuthenticating: boolean;
  isRestoringSession: boolean;
  /** True when the session was restored from cache while the server was
   *  unreachable (the app started offline). */
  restoredOffline: boolean;
  serverUrl: string | null;
  setServerUrl: (url: string) => Promise<void>;
  initiateOAuth: () => Promise<void>;
  completeOAuthWithCode: (callbackOrCode: string) => Promise<void>;
  login: (input: { serverUrl: string; apiKey: string }) => Promise<void>;
  logout: () => void;
};

export function useSession(): UseSessionReturn {
  const [session, setSession] = useState<Session | null>(null);
  const [serverUrl, setServerUrlState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [restoredOffline, setRestoredOffline] = useState(false);
  const isDev = import.meta.env.DEV;
  const processedCallbackUrlsRef = useRef<Set<string>>(new Set());
  const callbackInFlightRef = useRef<Set<string>>(new Set());

  async function completeOAuthFromCallbackUrl(callbackUrl: string) {
    const storedServerUrl = sessionStorage.getItem("oauth_server_url");
    console.log("[oauth:ui:callback] incoming callbackUrl", callbackUrl);

    if (!storedServerUrl) {
      console.log("[oauth:ui:callback] missing stored oauth server url");
      return;
    }

    let hasCode = false;
    try {
      const parsedUrl = new URL(callbackUrl);
      const isImmichScheme = parsedUrl.protocol === "app.immich:";
      const hasCallbackHost = parsedUrl.hostname === "oauth-callback";
      const hasCallbackPath = parsedUrl.pathname.includes("oauth-callback");
      const isDevHttpCallback =
        (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
        parsedUrl.pathname.includes("oauth-callback");
      const isOAuthCallback =
        (isImmichScheme && (hasCallbackHost || hasCallbackPath)) ||
        isDevHttpCallback;
      console.log("[oauth:ui:callback] parsed", {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        pathname: parsedUrl.pathname,
        search: parsedUrl.search,
        hash: parsedUrl.hash,
        isOAuthCallback,
      });
      if (!isOAuthCallback) {
        return;
      }

      hasCode = !!parsedUrl.searchParams.get("code");
      if (!hasCode && parsedUrl.hash) {
        const hashParams = new URLSearchParams(
          parsedUrl.hash.replace(/^#/, ""),
        );
        hasCode = !!hashParams.get("code");
      }
    } catch {
      return;
    }

    if (!hasCode) {
      console.log("[oauth:ui:callback] no code found in callback URL");
      return;
    }

    if (processedCallbackUrlsRef.current.has(callbackUrl)) {
      console.log(
        "[oauth:ui:callback] callback already processed, skipping",
        callbackUrl,
      );
      return;
    }

    if (callbackInFlightRef.current.has(callbackUrl)) {
      console.log(
        "[oauth:ui:callback] callback already in-flight, skipping",
        callbackUrl,
      );
      return;
    }

    callbackInFlightRef.current.add(callbackUrl);

    setIsAuthenticating(true);

    try {
      console.log("[oauth:ui:callback] completing oauth", {
        serverUrl: storedServerUrl,
        callbackUrl,
      });
      const authResponse = await completeOAuthFlow(
        storedServerUrl,
        callbackUrl,
      );
      console.log("[oauth:ui:callback] complete success", authResponse);

      setSession({
        serverUrl: storedServerUrl,
        accessToken: "",
        userId: authResponse.userId,
        userName: authResponse.userName ?? authResponse.userId,
      });
      setServerUrlState(storedServerUrl);
      setError(null);
      processedCallbackUrlsRef.current.add(callbackUrl);

      sessionStorage.removeItem("oauth_server_url");

      if (isDev) {
        const parsedUrl = new URL(window.location.href);
        if (parsedUrl.pathname.includes("oauth-callback")) {
          window.history.replaceState({}, document.title, "/");
        }
      }
    } catch (err) {
      console.error("[oauth:ui:callback] complete failed", err);
      const message =
        err instanceof Error ? err.message : "Failed to complete OAuth";
      setError(message);
      setSession(null);
    } finally {
      callbackInFlightRef.current.delete(callbackUrl);
      setIsAuthenticating(false);
    }
  }

  // Setup OAuth callback listener
  useEffect(() => {
    void completeOAuthFromCallbackUrl(window.location.href);

    let unsubscribe: (() => void) | null = null;
    let disposed = false;

    async function setupDeepLinkListener() {
      try {
        const { getCurrent, onOpenUrl } =
          await import("@tauri-apps/plugin-deep-link");
        console.log("[oauth:ui:deep-link] plugin loaded");

        const startupUrls = await getCurrent();
        console.log("[oauth:ui:deep-link] getCurrent urls", startupUrls);
        const startupUrl = startupUrls?.[startupUrls.length - 1];
        if (startupUrl) {
          await completeOAuthFromCallbackUrl(startupUrl);
        }

        const unlisten = await onOpenUrl((urls) => {
          console.log("[oauth:ui:deep-link] onOpenUrl urls", urls);
          const latestUrl = urls[urls.length - 1];
          if (latestUrl) {
            void completeOAuthFromCallbackUrl(latestUrl);
          }
        });

        if (disposed) {
          unlisten();
          return;
        }

        unsubscribe = unlisten;
        console.log("[oauth:ui:deep-link] listener registered");
      } catch (err) {
        console.error(
          "[oauth:ui:deep-link] failed to initialize listener",
          err,
        );
      }
    }

    void setupDeepLinkListener();

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  // Restore session from DB on mount
  useEffect(() => {
    let cancelled = false;

    async function tryRestoreSession() {
      try {
        const response = await restoreSession();
        if (!cancelled && response) {
          setSession({
            serverUrl: response.serverUrl,
            accessToken: "",
            userId: response.userId,
            userName: response.userName ?? response.userId,
          });
          setServerUrlState(response.serverUrl);
          setRestoredOffline(response.offline);
          if (response.offline) {
            console.warn(
              "[session] restored from cache while offline — entering offline mode",
            );
          }
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

  async function setServerUrl(url: string) {
    setError(null);
    setServerUrlState(url);
  }

  async function initiateOAuth() {
    if (!serverUrl) {
      setError("Server URL not set");
      return;
    }

    setError(null);
    setIsAuthenticating(true);

    try {
      console.log("[oauth:ui:start] requesting authorization url", {
        serverUrl,
      });
      const redirectUri = isDev
        ? `${window.location.origin}/oauth-callback`
        : "app.immich://oauth-callback";

      const oauthUrl = await getOAuthAuthorizationUrl(serverUrl, redirectUri);
      console.log("[oauth:ui:start] received authorization response", oauthUrl);

      // Store server URL to resolve callback after browser/webview handoff.
      sessionStorage.setItem("oauth_server_url", serverUrl);

      if (isDev) {
        console.log(
          "[oauth:ui:start] navigating current webview",
          oauthUrl.authorizationUrl,
        );
        window.location.assign(oauthUrl.authorizationUrl);
        return;
      }

      await openUrl(oauthUrl.authorizationUrl);
      console.log(
        "[oauth:ui:start] opened external url",
        oauthUrl.authorizationUrl,
      );

      setIsAuthenticating(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to initiate OAuth";
      setError(message);
      setIsAuthenticating(false);
    }
  }

  async function completeOAuthWithCode(callbackOrCode: string) {
    if (!serverUrl) {
      setError("Server URL not set");
      return;
    }

    setError(null);
    setIsAuthenticating(true);

    try {
      const rawInput = callbackOrCode.trim();
      const callbackUrl = rawInput.includes("://")
        ? rawInput
        : isDev
          ? `${window.location.origin}/oauth-callback?code=${encodeURIComponent(rawInput)}`
          : `app.immich://oauth-callback?code=${encodeURIComponent(rawInput)}`;
      console.log("[oauth:ui:manual] completing with", {
        serverUrl,
        callbackUrl,
      });

      const authResponse = await completeOAuthFlow(serverUrl, callbackUrl);
      console.log("[oauth:ui:manual] complete success", authResponse);
      setSession({
        serverUrl,
        accessToken: "",
        userId: authResponse.userId,
        userName: authResponse.userName ?? authResponse.userId,
      });
      setError(null);

      // Clear OAuth state
      sessionStorage.removeItem("oauth_server_url");
    } catch (err) {
      console.error("[oauth:ui:manual] complete failed", err);
      const message =
        err instanceof Error
          ? err.message
          : "Failed to complete OAuth. Please check the code and try again.";
      setError(message);
      setSession(null);
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function login(input: { serverUrl: string; apiKey: string }) {
    setError(null);
    setIsAuthenticating(true);

    try {
      const authResponse = await authenticate(input.serverUrl, input.apiKey);
      setSession({
        serverUrl: input.serverUrl,
        accessToken: input.apiKey,
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
    sessionStorage.removeItem("oauth_server_url");
    processedCallbackUrlsRef.current.clear();
    callbackInFlightRef.current.clear();

    setSession(null);
    setServerUrlState(null);
    setError(null);

    void (async () => {
      try {
        await clearWebviewBrowsingData();
        console.log("[oauth:ui:logout] cleared webview browsing data");
      } catch (err) {
        console.error(
          "[oauth:ui:logout] failed to clear webview browsing data",
          err,
        );
      }

      try {
        await logoutFromServer();
      } catch (err) {
        console.error("Failed to clear server session:", err);
      }
    })();
  }

  return {
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
    logout,
  };
}
