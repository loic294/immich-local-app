import { useCallback, useEffect, useState } from "react";
import {
  addAccountCompleteOAuth,
  addAccountOAuthUrl,
  addAccountWithKey,
  addAccountWithPassword,
  listAccounts,
  openUrl,
  removeAccount as removeAccountApi,
  setPrimaryAccount as setPrimaryAccountApi,
  type Account,
} from "../api/tauri";

export type UseAccountsReturn = {
  accounts: Account[];
  primaryAccount: Account | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addWithKey: (serverUrl: string, apiKey: string) => Promise<Account>;
  addWithPassword: (
    serverUrl: string,
    email: string,
    password: string,
  ) => Promise<Account>;
  startAddOAuth: (serverUrl: string) => Promise<void>;
  completeAddOAuth: (
    serverUrl: string,
    callbackUrl: string,
  ) => Promise<Account>;
  setPrimary: (accountId: string) => Promise<void>;
  remove: (accountId: string) => Promise<void>;
};

/**
 * Manages the locally-registered account registry: lists all signed-in
 * accounts, and adds/removes/re-primaries them. Every account stays signed in
 * simultaneously so views can mix assets across accounts.
 */
export function useAccounts(): UseAccountsReturn {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listAccounts();
      setAccounts(next);
      setError(null);
    } catch (err) {
      console.error("[accounts] failed to list accounts", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addWithKey = useCallback(
    async (serverUrl: string, apiKey: string) => {
      const account = await addAccountWithKey(serverUrl, apiKey);
      await refresh();
      return account;
    },
    [refresh],
  );

  const addWithPassword = useCallback(
    async (serverUrl: string, email: string, password: string) => {
      const account = await addAccountWithPassword(serverUrl, email, password);
      await refresh();
      return account;
    },
    [refresh],
  );

  const startAddOAuth = useCallback(async (serverUrl: string) => {
    const { authorizationUrl } = await addAccountOAuthUrl(serverUrl);
    // Remember which server the in-flight add-account OAuth flow targets so the
    // deep-link callback can finish it.
    sessionStorage.setItem("add_account_oauth_server_url", serverUrl);
    await openUrl(authorizationUrl);
  }, []);

  const completeAddOAuth = useCallback(
    async (serverUrl: string, callbackUrl: string) => {
      const account = await addAccountCompleteOAuth(serverUrl, callbackUrl);
      sessionStorage.removeItem("add_account_oauth_server_url");
      await refresh();
      return account;
    },
    [refresh],
  );

  const setPrimary = useCallback(
    async (accountId: string) => {
      await setPrimaryAccountApi(accountId);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (accountId: string) => {
      await removeAccountApi(accountId);
      await refresh();
    },
    [refresh],
  );

  const primaryAccount =
    accounts.find((account) => account.isPrimary) ?? accounts[0] ?? null;

  return {
    accounts,
    primaryAccount,
    isLoading,
    error,
    refresh,
    addWithKey,
    addWithPassword,
    startAddOAuth,
    completeAddOAuth,
    setPrimary,
    remove,
  };
}
