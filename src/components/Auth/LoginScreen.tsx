import { useState, FormEvent } from "react";
import logoUrl from "../../assets/logo.svg";
import { useI18n } from "../../i18n";

type LoginScreenProps = {
  serverUrl: string;
  onAuthorize: () => Promise<void>;
  onCodeSubmit: (callbackOrCode: string) => Promise<void>;
  onApiKeySubmit: (apiKey: string) => Promise<void>;
  onPasswordSubmit: (email: string, password: string) => Promise<void>;
  isLoading: boolean;
  error: string | null;
  onBack: () => void;
};

export function LoginScreen({
  serverUrl,
  onAuthorize,
  onCodeSubmit,
  onApiKeySubmit,
  onPasswordSubmit,
  isLoading,
  error,
  onBack,
}: LoginScreenProps) {
  const { t } = useI18n();
  const [callbackUrl, setCallbackUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authorizationStarted, setAuthorizationStarted] = useState(false);
  const [authMode, setAuthMode] = useState<"dev" | "apiKey" | "password">(
    "dev",
  );

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

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (normalizedEmail && password.trim()) {
      await onPasswordSubmit(normalizedEmail, password);
    }
  }

  return (
    <section className="card mx-auto mt-20 w-full max-w-md border border-base-300 bg-base-100 shadow-xl">
      <div className="card-body">
        <img src={logoUrl} alt="" className="mb-2 h-14 w-14 rounded-lg" />
        <h1 className="card-title text-2xl">{t("auth.signInTitle")}</h1>
        <p className="text-sm text-base-content/70">
          {t("auth.connectAt", { serverUrl })}
        </p>

        <div className="join w-full">
          <button
            type="button"
            onClick={() => {
              setAuthMode("dev");
              setApiKey("");
              setEmail("");
              setPassword("");
            }}
            disabled={isLoading}
            className={`btn join-item flex-1 ${authMode === "dev" ? "btn-primary" : "btn-outline"}`}
          >
            {t("auth.modeDev")}
          </button>
          <button
            type="button"
            onClick={() => {
              setAuthMode("apiKey");
              setAuthorizationStarted(false);
              setCallbackUrl("");
              setEmail("");
              setPassword("");
            }}
            disabled={isLoading}
            className={`btn join-item flex-1 ${authMode === "apiKey" ? "btn-primary" : "btn-outline"}`}
          >
            {t("auth.modeApiKey")}
          </button>
          <button
            type="button"
            onClick={() => {
              setAuthMode("password");
              setAuthorizationStarted(false);
              setCallbackUrl("");
              setApiKey("");
            }}
            disabled={isLoading}
            className={`btn join-item flex-1 ${authMode === "password" ? "btn-primary" : "btn-outline"}`}
          >
            {t("auth.modePassword")}
          </button>
        </div>

        {authMode === "apiKey" ? (
          <form onSubmit={handleApiKeySubmit} className="space-y-4">
            <p className="text-sm text-base-content/70">
              {t("auth.apiKeyHelp")}
            </p>

            <label className="form-control w-full">
              <span className="label-text mb-1">{t("auth.apiKeyLabel")}</span>
              <input
                required
                type="password"
                placeholder={t("auth.apiKeyPlaceholder")}
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
                {isLoading ? t("auth.signingIn") : t("auth.apiKeySubmit")}
              </button>
              <button
                type="button"
                onClick={onBack}
                disabled={isLoading}
                className="btn btn-ghost w-full"
              >
                {t("auth.back")}
              </button>
            </div>
          </form>
        ) : authMode === "password" ? (
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <p className="text-sm text-base-content/70">
              {t("auth.passwordHelp")}
            </p>

            <label className="form-control w-full">
              <span className="label-text mb-1">{t("auth.emailLabel")}</span>
              <input
                required
                type="email"
                placeholder={t("auth.emailPlaceholder")}
                value={email}
                className="input input-bordered w-full"
                onChange={(event) => setEmail(event.target.value)}
                disabled={isLoading}
              />
            </label>

            <label className="form-control w-full">
              <span className="label-text mb-1">
                {t("auth.passwordLabel")}
              </span>
              <input
                required
                type="password"
                placeholder={t("auth.passwordPlaceholder")}
                value={password}
                className="input input-bordered w-full"
                onChange={(event) => setPassword(event.target.value)}
                disabled={isLoading}
              />
            </label>

            <div className="space-y-2">
              <button
                type="submit"
                disabled={isLoading || !email.trim() || !password.trim()}
                className="btn btn-primary w-full"
              >
                {isLoading ? t("auth.signingIn") : t("auth.passwordSubmit")}
              </button>
              <button
                type="button"
                onClick={onBack}
                disabled={isLoading}
                className="btn btn-ghost w-full"
              >
                {t("auth.back")}
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
              {isLoading ? t("auth.openingBrowser") : t("auth.startOauth")}
            </button>
            <button
              onClick={onBack}
              disabled={isLoading}
              className="btn btn-ghost w-full"
            >
              {t("auth.back")}
            </button>
          </div>
        ) : (
          <form onSubmit={handleCodeSubmit} className="space-y-4">
            <p className="text-sm text-base-content/70">
              {t("auth.oauthHelpA")}
            </p>
            <p className="text-sm text-base-content/70">
              {t("auth.oauthHelpB")}
            </p>

            <label className="form-control w-full">
              <span className="label-text mb-1">{t("auth.authCodeLabel")}</span>
              <input
                required
                type="text"
                placeholder={t("auth.authCodePlaceholder")}
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
                {isLoading ? t("auth.verifying") : t("auth.verifyCode")}
              </button>
              <button
                type="button"
                onClick={() => setAuthorizationStarted(false)}
                disabled={isLoading}
                className="btn btn-ghost w-full"
              >
                {t("auth.cancel")}
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
