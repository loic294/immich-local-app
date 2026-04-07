import { FormEvent, useState } from "react";

type LoginScreenProps = {
  onSubmit: (input: { serverUrl: string; apiKey: string }) => Promise<void>;
  initialServerUrl?: string;
  initialApiKey?: string;
  isLoading: boolean;
  error: string | null;
};

export function LoginScreen({
  onSubmit,
  initialServerUrl,
  initialApiKey,
  isLoading,
  error,
}: LoginScreenProps) {
  const [serverUrl, setServerUrl] = useState(
    initialServerUrl ?? "http://localhost:2283",
  );
  const [apiKey, setApiKey] = useState(initialApiKey ?? "");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({ serverUrl, apiKey });
  }

  return (
    <section className="card mx-auto mt-20 w-full max-w-md border border-base-300 bg-base-100 shadow-xl">
      <div className="card-body">
        <h1 className="card-title text-2xl">Connect to Immich</h1>
        <p className="text-sm text-base-content/70">
          Milestone 1: authenticate and fetch first asset page.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="form-control w-full">
            <span className="label-text mb-1">Server URL</span>
            <input
              required
              type="url"
              value={serverUrl}
              className="input input-bordered w-full"
              onChange={(event) => setServerUrl(event.target.value)}
            />
          </label>

          <label className="form-control w-full">
            <span className="label-text mb-1">API Key</span>
            <input
              required
              type="password"
              placeholder="Enter your Immich API key"
              value={apiKey}
              className="input input-bordered w-full"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>

          <button
            disabled={isLoading}
            type="submit"
            className="btn btn-primary w-full"
          >
            {isLoading ? "Connecting..." : "Connect"}
          </button>
        </form>

        {error ? (
          <div role="alert" className="alert alert-error alert-soft text-sm">
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
