import { FormEvent, useState } from "react";

type ServerUrlScreenProps = {
  onSubmit: (serverUrl: string) => Promise<void>;
  initialServerUrl?: string;
  isLoading: boolean;
  error: string | null;
};

export function ServerUrlScreen({
  onSubmit,
  initialServerUrl,
  isLoading,
  error,
}: ServerUrlScreenProps) {
  const [serverUrl, setServerUrl] = useState(
    initialServerUrl ?? "http://localhost:2283",
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(serverUrl);
  }

  return (
    <section className="card mx-auto mt-20 w-full max-w-md border border-base-300 bg-base-100 shadow-xl">
      <div className="card-body">
        <h1 className="card-title text-2xl">Connect to Immich</h1>
        <p className="text-sm text-base-content/70">
          Enter your Immich server URL to get started.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="form-control w-full">
            <span className="label-text mb-1">Server URL</span>
            <input
              required
              type="url"
              value={serverUrl}
              placeholder="https://immich.example.com"
              className="input input-bordered w-full"
              onChange={(event) => setServerUrl(event.target.value)}
              disabled={isLoading}
            />
            <span className="label-text-alt text-xs text-base-content/50 mt-1">
              e.g. http://localhost:2283 or https://immich.example.com
            </span>
          </label>

          <button
            disabled={isLoading || !serverUrl.trim()}
            type="submit"
            className="btn btn-primary w-full"
          >
            {isLoading ? "Connecting..." : "Next"}
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
