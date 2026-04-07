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
    <section className="card">
      <h1>Connect to Immich</h1>
      <p className="subtitle">
        Milestone 1: authenticate and fetch first asset page.
      </p>

      <form onSubmit={handleSubmit} className="form">
        <label>
          Server URL
          <input
            required
            type="url"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
          />
        </label>
        <label>
          API Key
          <input
            required
            type="password"
            placeholder="Enter your Immich API key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>

        <button disabled={isLoading} type="submit">
          {isLoading ? "Connecting..." : "Connect"}
        </button>
      </form>

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
