import { FormEvent, useState } from "react";
import { KeyRound, Globe, Mail, X } from "lucide-react";
import type { UseAccountsReturn } from "../../hooks/useAccounts";
import { useI18n } from "../../i18n";

type AddAccountModalProps = {
  accounts: UseAccountsReturn;
  onClose: () => void;
  /** Called after an account is successfully added. */
  onAdded: () => void;
};

type Step = "server" | "method";
type Method = "oauth" | "apiKey" | "password";

/**
 * Modal that walks the user through adding a secondary account. It first asks
 * for the server URL, then lets them sign in with OAuth (browser + callback
 * paste), an API key, or email/password. Every method routes through the
 * `useAccounts` registry so the new account stays signed in alongside the
 * others.
 */
export function AddAccountModal({
  accounts,
  onClose,
  onAdded,
}: AddAccountModalProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>("server");
  const [method, setMethod] = useState<Method>("oauth");
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [oauthStarted, setOauthStarted] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedServer = serverUrl.trim().replace(/\/+$/, "");

  const handleServerSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedServer) {
      return;
    }
    setError(null);
    setStep("method");
  };

  const finishSuccess = () => {
    setIsBusy(false);
    onAdded();
    onClose();
  };

  const runAdd = async (action: () => Promise<unknown>) => {
    setError(null);
    setIsBusy(true);
    try {
      await action();
      finishSuccess();
    } catch (err) {
      console.error("[accounts] add account failed", err);
      setError(err instanceof Error ? err.message : t("account.addFailed"));
      setIsBusy(false);
    }
  };

  const handleApiKeySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!apiKey.trim()) {
      return;
    }
    void runAdd(() => accounts.addWithKey(normalizedServer, apiKey.trim()));
  };

  const handlePasswordSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password.trim()) {
      return;
    }
    void runAdd(() =>
      accounts.addWithPassword(normalizedServer, email.trim(), password),
    );
  };

  const handleStartOauth = async () => {
    setError(null);
    setIsBusy(true);
    try {
      await accounts.startAddOAuth(normalizedServer);
      setOauthStarted(true);
    } catch (err) {
      console.error("[accounts] start add-account oauth failed", err);
      setError(err instanceof Error ? err.message : t("account.addFailed"));
    } finally {
      setIsBusy(false);
    }
  };

  const handleCallbackSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!callbackUrl.trim()) {
      return;
    }
    void runAdd(() =>
      accounts.completeAddOAuth(normalizedServer, callbackUrl.trim()),
    );
  };

  const methodButtonClass = (value: Method) =>
    `btn join-item flex-1 ${method === value ? "btn-primary" : "btn-outline"}`;

  return (
    <div className="fixed inset-0 z-130 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-md rounded-box border border-base-300 bg-base-100 p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="m-0 text-lg font-semibold">{t("account.addTitle")}</h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onClose}
            disabled={isBusy}
            aria-label={t("account.cancel")}
          >
            <X size={16} />
          </button>
        </div>

        {step === "server" ? (
          <form onSubmit={handleServerSubmit} className="space-y-4">
            <label className="form-control w-full">
              <span className="label-text mb-1">
                {t("account.serverLabel")}
              </span>
              <input
                required
                type="url"
                inputMode="url"
                autoFocus
                placeholder={t("account.serverPlaceholder")}
                value={serverUrl}
                className="input input-bordered w-full"
                onChange={(event) => setServerUrl(event.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {t("account.cancel")}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!normalizedServer}
              >
                {t("account.continue")}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <p className="m-0 truncate text-xs text-base-content/60">
              {normalizedServer}
            </p>

            <div className="join w-full">
              <button
                type="button"
                className={methodButtonClass("oauth")}
                onClick={() => {
                  setMethod("oauth");
                  setError(null);
                }}
                disabled={isBusy}
              >
                <Globe size={14} className="shrink-0" />
                {t("account.methodOAuth")}
              </button>
              <button
                type="button"
                className={methodButtonClass("apiKey")}
                onClick={() => {
                  setMethod("apiKey");
                  setError(null);
                }}
                disabled={isBusy}
              >
                <KeyRound size={14} className="shrink-0" />
                {t("account.methodApiKey")}
              </button>
              <button
                type="button"
                className={methodButtonClass("password")}
                onClick={() => {
                  setMethod("password");
                  setError(null);
                }}
                disabled={isBusy}
              >
                <Mail size={14} className="shrink-0" />
                {t("account.methodPassword")}
              </button>
            </div>

            {method === "apiKey" ? (
              <form onSubmit={handleApiKeySubmit} className="space-y-4">
                <label className="form-control w-full">
                  <span className="label-text mb-1">
                    {t("auth.apiKeyLabel")}
                  </span>
                  <input
                    required
                    type="password"
                    placeholder={t("auth.apiKeyPlaceholder")}
                    value={apiKey}
                    className="input input-bordered w-full"
                    onChange={(event) => setApiKey(event.target.value)}
                    disabled={isBusy}
                  />
                </label>
                <button
                  type="submit"
                  className="btn btn-primary w-full"
                  disabled={isBusy || !apiKey.trim()}
                >
                  {isBusy ? t("account.adding") : t("account.addAccount")}
                </button>
              </form>
            ) : method === "password" ? (
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <label className="form-control w-full">
                  <span className="label-text mb-1">
                    {t("auth.emailLabel")}
                  </span>
                  <input
                    required
                    type="email"
                    value={email}
                    className="input input-bordered w-full"
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={isBusy}
                  />
                </label>
                <label className="form-control w-full">
                  <span className="label-text mb-1">
                    {t("auth.passwordLabel")}
                  </span>
                  <input
                    required
                    type="password"
                    value={password}
                    className="input input-bordered w-full"
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={isBusy}
                  />
                </label>
                <button
                  type="submit"
                  className="btn btn-primary w-full"
                  disabled={isBusy || !email.trim() || !password.trim()}
                >
                  {isBusy ? t("account.adding") : t("account.addAccount")}
                </button>
              </form>
            ) : !oauthStarted ? (
              <div className="space-y-3">
                <p className="m-0 text-sm text-base-content/70">
                  {t("account.oauthHelp")}
                </p>
                <button
                  type="button"
                  className="btn btn-primary w-full"
                  onClick={() => {
                    void handleStartOauth();
                  }}
                  disabled={isBusy}
                >
                  {t("account.startOauth")}
                </button>
              </div>
            ) : (
              <form onSubmit={handleCallbackSubmit} className="space-y-4">
                <label className="form-control w-full">
                  <span className="label-text mb-1">
                    {t("account.callbackLabel")}
                  </span>
                  <input
                    required
                    type="text"
                    placeholder={t("account.callbackPlaceholder")}
                    value={callbackUrl}
                    className="input input-bordered w-full"
                    onChange={(event) => setCallbackUrl(event.target.value)}
                    disabled={isBusy}
                  />
                </label>
                <button
                  type="submit"
                  className="btn btn-primary w-full"
                  disabled={isBusy || !callbackUrl.trim()}
                >
                  {isBusy ? t("account.verifying") : t("account.verify")}
                </button>
              </form>
            )}

            <button
              type="button"
              className="btn btn-ghost btn-sm w-full"
              onClick={() => {
                setStep("server");
                setOauthStarted(false);
                setError(null);
              }}
              disabled={isBusy}
            >
              {t("account.back")}
            </button>
          </div>
        )}

        {error ? (
          <div
            role="alert"
            className="alert alert-error alert-soft mt-3 text-sm"
          >
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
