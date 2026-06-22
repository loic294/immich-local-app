import { useI18n } from "../../i18n";
import type { Account } from "../../api/tauri";

interface AccountFilterProps {
  /** Selected account id, or null for all accounts. */
  value: string | null;
  /** All registered accounts. */
  accounts: Account[];
  onChange: (value: string | null) => void;
}

/**
 * daisyUI select listing every registered account so the user can narrow the
 * grid to a single account's photos. Only rendered when more than one account
 * is signed in.
 */
export function AccountFilter({
  value,
  accounts,
  onChange,
}: AccountFilterProps) {
  const { t } = useI18n();

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <select
        className="select select-sm z-10 w-48"
        value={value ?? ""}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === "" ? null : next);
        }}
        aria-label={t("filters.accountAria")}
      >
        <option value="">{t("filters.allAccounts")}</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.userName || account.userEmail || account.serverUrl}
          </option>
        ))}
      </select>
    </div>
  );
}
