import { useState, FormEvent } from "react";

type LoginScreenProps = {
  serverUrl: string;
  onAuthorize: () => Promise<void>;
  onCodeSubmit: (callbackOrCode: string) => Promise<void>;
  onApiKeySubmit: (apiKey: string) => Promise<void>;
  isLoading: boolean;
  error: string | null;
  onBack: () => void;
};

export function LoginScreen({
  serverUrl,
  onAuthorize,
  onCodeSubmit,
  onApiKeySubmit,
  isLoading,
  error,
  onBack,
}: LoginScreenProps) {
  const [callbackUrl, setCallbackUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [authorizationStarted, setAuthorizationStarted] = useState(false);
  const [authMode, setAuthMode] = useState<"dev" | "apiKey">("dev");

  async function handleAuthorizeClick() {
    setAuthorizationStarted(true);
    await onAuthorize();
  }

  async function handleCodeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (callbackUrl.trim()) {
      await onCodeSubmit(callbackUrl);
    }
  }

  async function handleApiKeySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (apiKey.trim()) {
      await onApiKeySubmit(apiKey.trim());
    }
  }

  return (
    <section className="card mx-auto mt-20 w-full max-w-md border border-base-300 bg-base-100 shadow-xl">
      <div className="card-body">
        <h1 className="card-title text-2xl">Sign in to Immich</h1>
        <p className="text-sm text-base-content/70">
          Connect to your Immich server at {serverUrl}
        </p>

        <div className="join w-full">
          <button
            type="button"
            onClick={() => {
              setAuthMode("dev");
              setApiKey("");
            }}
            disabled={isLoading}
            className={`btn join-item flex-1 ${authMode === "dev" ? "btn-primary" : "btn-outline"}`}
          >
            Dev Mode
          </button>
          <button
            type="button"
            onClick={() => {
              setAuthMode("apiKey");
              setAuthorizationStarted(false);
              setCallbackUrl("");
            }}
            disabled={isLoading}
            className={`btn join-item flex-1 ${authMode === "apiKey" ? "btn-primary" : "btn-outline"}`}
          >
            API Key
          </button>
        </div>

        {authMode === "apiKey" ? (
          <form onSubmit={handleApiKeySubmit} className="space-y-4">
            <p className="text-sm text-base-content/70">
              Paste your Immich API key to sign in directly.
            </p>

            <label className="form-control w-full">
              <span className="label-text mb-1">API Key</span>
              <input
                required
                type="password"
                placeholder="immich_api_key..."
                value={apiKey}
                className="input input-bordered w-full"
                onChange={(event) => setApiKey(event.target.value)}
                disabled={isLoading}
              />
            </label>

            <div className="space-y-2">
              <button
                type="submit"
                disabled={isLoading || !apiKey.trim()}
                className="btn btn-primary w-full"
              >
                {isLoading ? "Signing in..." : "Sign in with API Key"}
              </button>
              <button
                type="button"
                onClick={onBack}
                disabled={isLoading}
                className="btn btn-ghost w-full"
              >
                Back
              </button>
            </div>
          </form>
        ) : !authorizationStarted ? (
          <div className="space-y-4">
            <button
              onClick={handleAuthorizeClick}
              disabled={isLoading}
              className="btn btn-primary w-full"
            >
              {isLoading ? "Opening browser..." : "Start OAuth in Browser"}
            </button>
            <button
              onClick={onBack}
              disabled={isLoading}
              className="btn btn-ghost w-full"
            >
              Back
            </button>
          </div>
        ) : (
          <form onSubmit={handleCodeSubmit} className="space-y-4">
            <p className="text-sm text-base-content/70">
              After signing in, you should be redirected back to this app
              automatically.
            </p>
            <p className="text-sm text-base-content/70">
              If it does not complete, paste either the full redirect URL or
              just the value of the code parameter below.
            </p>

            <label className="form-control w-full">
              <span className="label-text mb-1">
                Authorization Code or Callback URL
              </span>
              <input
                required
                type="text"
                placeholder="code=... or app.immich:///oauth-callback?..."
                value={callbackUrl}
                className="input input-bordered w-full"
                onChange={(event) => setCallbackUrl(event.target.value)}
                disabled={isLoading}
              />
            </label>

            <div className="space-y-2">
              <button
                type="submit"
                disabled={isLoading || !callbackUrl.trim()}
                className="btn btn-primary w-full"
              >
                {isLoading ? "Verifying..." : "Verify Code"}
              </button>
              <button
                type="button"
                onClick={() => setAuthorizationStarted(false)}
                disabled={isLoading}
                className="btn btn-ghost w-full"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {error ? (
          <div role="alert" className="alert alert-error alert-soft text-sm">
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
