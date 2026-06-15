import { FormEvent, useState } from "react";
import { useI18n } from "../../i18n";

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
  const { t } = useI18n();
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
        <h1 className="card-title text-2xl">{t("server.title")}</h1>
        <p className="text-sm text-base-content/70">{t("server.subtitle")}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="form-control w-full">
            <span className="label-text mb-1">{t("server.label")}</span>
            <input
              required
              type="url"
              value={serverUrl}
              placeholder={t("server.placeholder")}
              className="input input-bordered w-full"
              onChange={(event) => setServerUrl(event.target.value)}
              disabled={isLoading}
            />
            <span className="label-text-alt text-xs text-base-content/50 mt-1">
              {t("server.hint")}
            </span>
          </label>

          <button
            disabled={isLoading || !serverUrl.trim()}
            type="submit"
            className="btn btn-primary w-full"
          >
            {isLoading ? t("server.connecting") : t("server.next")}
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
