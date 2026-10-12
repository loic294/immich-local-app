import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getFoldersBaseDirectory, setFoldersBaseDirectory, type Account } from "../../api/tauri";
import { useI18n } from "../../i18n";

interface AccountsBaseDirectorySettingsProps {
  accounts: Account[];
}

export function AccountsBaseDirectorySettings({ accounts }: AccountsBaseDirectorySettingsProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [loadedAccounts, setLoadedAccounts] = useState<string[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all(
      accounts.map(async (account) => {
        try {
          return [account.id, await getFoldersBaseDirectory(account.id)] as const;
        } catch (loadError) {
          console.error("[folders] failed to load account base directory", {
            accountId: account.id,
            error: loadError,
          });
          return null;
        }
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        const loaded = entries.filter((entry) => entry !== null);
        setDrafts(Object.fromEntries(loaded));
        setLoadedAccounts(loaded.map(([id]) => id));
        if (loaded.length !== accounts.length) {
          setError(t("settings.foldersBaseDirectoryLoadFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accounts, t, loadNonce]);

  const save = async (accountId: string) => {
    setSaving(accountId);
    setError(null);
    setSaved((current) => ({ ...current, [accountId]: false }));
    console.info("[folders.base_directory] saving", { accountId });
    try {
      const result = await setFoldersBaseDirectory(accountId, drafts[accountId] ?? "");
      setDrafts((current) => ({ ...current, [accountId]: result }));
      setSaved((current) => ({ ...current, [accountId]: true }));
      void queryClient.invalidateQueries({ queryKey: ["folder-paths"] });
      void queryClient.invalidateQueries({ queryKey: ["folder-assets-paged"] });
      console.info("[folders.base_directory] saved", { accountId, baseDirectory: result });
    } catch (saveError) {
      console.error("[folders] failed to save account base directory", {
        accountId,
        error: saveError,
      });
      setError(`${t("settings.foldersBaseDirectoryInvalid")} ${String(saveError)}`);
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="mt-5 space-y-3 border-t border-base-300 pt-4">
      <div>
        <h3 className="font-semibold">{t("settings.foldersBaseDirectory")}</h3>
        <p className="text-sm text-base-content/70">{t("settings.foldersBaseDirectoryHelp")}</p>
      </div>
      {accounts.map((account) => {
        const accountLabel = account.userName || account.userEmail || account.userId;
        return (
          <div key={account.id} className="rounded-box border border-base-300 bg-base-200 p-3">
            <label className="fieldset">
              <span className="fieldset-legend">{accountLabel}</span>
              <div className="flex flex-wrap gap-2">
                <input
                  className="input min-w-48 flex-1"
                  type="text"
                  value={drafts[account.id] ?? ""}
                  placeholder={t("settings.foldersBaseDirectoryPlaceholder")}
                  disabled={loading || saving !== null || !loadedAccounts.includes(account.id)}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDrafts((current) => ({
                      ...current,
                      [account.id]: value,
                    }));
                    setSaved((current) => ({ ...current, [account.id]: false }));
                    setError(null);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={loading || saving !== null || !loadedAccounts.includes(account.id)}
                  onClick={() => void save(account.id)}
                >
                  {saving === account.id
                    ? t("settings.saving")
                    : t("settings.saveFoldersBaseDirectory")}
                </button>
              </div>
            </label>
            {saved[account.id] && (
              <p role="status" className="mt-2 text-sm text-success">
                {t("settings.foldersBaseDirectorySaved")}
              </p>
            )}
          </div>
        );
      })}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {!loading && loadedAccounts.length !== accounts.length && (
        <button type="button" className="btn btn-sm" onClick={() => setLoadNonce((n) => n + 1)}>
          {t("settings.foldersBaseDirectoryRetry")}
        </button>
      )}
    </section>
  );
}
