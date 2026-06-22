import { Funnel, LogOut, Plus, Search, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getProfileImage } from "../../api/tauri";
import { SortButton } from "../Filters/SortButton";
import type { SortPreference } from "../../types";
import { useI18n } from "../../i18n";
import { useAccounts } from "../../hooks/useAccounts";
import { AddAccountModal } from "../Auth/AddAccountModal";

interface HeaderProps {
  searchInput: string;
  onSearchChange: (value: string) => void;
  serverUrl: string;
  userId: string;
  userName: string;
  onLogout: () => void;
  searchPlaceholder?: string;
  /** Whether to show the Filter button (only on photo grid views). */
  showFilterButton?: boolean;
  /** Whether any filter is currently active (highlights the button). */
  filterActive?: boolean;
  /** Whether the filter bar is currently open. */
  filterOpen?: boolean;
  onToggleFilter?: () => void;
  /** Whether to show the Sort button (only on photo grid views). */
  showSortButton?: boolean;
  sortPreference?: SortPreference;
  onSortChange?: (patch: Partial<SortPreference>) => void;
}

export function Header({
  searchInput,
  onSearchChange,
  serverUrl,
  userId,
  userName,
  onLogout,
  searchPlaceholder,
  showFilterButton = false,
  filterActive = false,
  filterOpen = false,
  onToggleFilter,
  showSortButton = false,
  sortPreference,
  onSortChange,
}: HeaderProps) {
  const { t } = useI18n();
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const accounts = useAccounts();
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);

  const handleMakePrimary = async (accountId: string) => {
    setAccountBusy(true);
    try {
      await accounts.setPrimary(accountId);
      // state.immich is bound to the primary at startup, so a reload is needed
      // for the change to fully take effect across the data layer.
      window.location.reload();
    } catch (err) {
      console.error("[accounts] make primary failed", err);
      setAccountBusy(false);
    }
  };

  const handleRemoveAccount = async (accountId: string) => {
    if (!window.confirm(t("account.removeConfirm"))) {
      return;
    }
    setAccountBusy(true);
    try {
      await accounts.remove(accountId);
      window.location.reload();
    } catch (err) {
      console.error("[accounts] remove account failed", err);
      setAccountBusy(false);
    }
  };

  const initials = useMemo(() => {
    const value = userName.trim();
    if (!value) {
      return "U";
    }

    const parts = value.split(/[._\-\s]+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
    }
    return value.slice(0, 2).toUpperCase();
  }, [userName]);

  useEffect(() => {
    let cancelled = false;

    async function loadProfileImage() {
      try {
        const value = await getProfileImage(userId);
        if (!cancelled) {
          setProfileImage(value);
        }
      } catch {
        if (!cancelled) {
          setProfileImage(null);
        }
      }
    }

    void loadProfileImage();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <header className="navbar border-b border-base-300 bg-base-100 px-3 sm:px-4">
      <div className="navbar-start gap-4">
        <label
          className="input input-bordered flex w-full min-w-[16rem] items-center gap-2 rounded-full sm:min-w-[20rem] lg:min-w-md"
          htmlFor="asset-search"
        >
          <Search size={16} className="text-base-content/60" />
          <input
            id="asset-search"
            placeholder={searchPlaceholder ?? t("header.searchPhotos")}
            type="text"
            className="grow"
            value={searchInput}
            onChange={(event) => {
              onSearchChange(event.target.value);
            }}
          />
        </label>
        {showFilterButton && (
          <button
            className={`btn btn-sm ${
              filterActive || filterOpen ? "btn-primary" : "btn-outline"
            }`}
            type="button"
            onClick={onToggleFilter}
            aria-pressed={filterOpen}
            aria-label={t("header.filterAria")}
          >
            <Funnel size={14} className="shrink-0" />
            <span>{t("header.filter")}</span>
          </button>
        )}
        {showSortButton && sortPreference && onSortChange && (
          <SortButton preference={sortPreference} onChange={onSortChange} />
        )}
      </div>

      <div className="navbar-end gap-2">
        <details className="dropdown dropdown-end">
          <summary
            className="btn btn-ghost btn-circle list-none"
            aria-label={t("header.accountMenuAria")}
          >
            {profileImage ? (
              <div className="avatar">
                <div className="w-8 rounded-full">
                  <img
                    src={profileImage}
                    alt={t("header.profileAlt")}
                    className="object-cover"
                  />
                </div>
              </div>
            ) : (
              <div className="avatar placeholder">
                <div className="w-8 rounded-full bg-primary text-primary-content text-xs font-bold flex justify-center items-center">
                  {initials}
                </div>
              </div>
            )}
          </summary>
          <div className="dropdown-content z-20 mt-2 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow">
            <p className="m-0 text-sm font-semibold text-base-content">
              {userName}
            </p>
            <p className="m-0 truncate text-xs text-base-content/60">
              {serverUrl}
            </p>

            {accounts.accounts.length > 0 ? (
              <>
                <div className="divider my-2 text-xs text-base-content/50">
                  {t("account.accountsTitle")}
                </div>
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {accounts.accounts.map((account) => {
                    const label =
                      account.userName || account.userEmail || account.userId;
                    const seed = (
                      account.userName ||
                      account.userEmail ||
                      "U"
                    ).trim();
                    const accountInitials =
                      seed.slice(0, 2).toUpperCase() || "U";
                    return (
                      <li
                        key={account.id}
                        className="flex items-center gap-2 rounded-box px-1 py-1"
                      >
                        <div className="avatar placeholder shrink-0">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-content">
                            {accountInitials}
                          </div>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="m-0 flex items-center gap-1 truncate text-sm font-medium text-base-content">
                            {label}
                            {account.isPrimary ? (
                              <span className="badge badge-primary badge-xs gap-1">
                                <Star size={9} />
                                {t("account.primaryBadge")}
                              </span>
                            ) : null}
                          </p>
                          <p className="m-0 truncate text-xs text-base-content/50">
                            {account.serverUrl}
                          </p>
                        </div>
                        {!account.isPrimary ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs btn-circle"
                              title={t("account.makePrimary")}
                              aria-label={t("account.makePrimary")}
                              disabled={accountBusy}
                              onClick={() => {
                                void handleMakePrimary(account.id);
                              }}
                            >
                              <Star size={14} />
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs btn-circle text-error"
                              title={t("account.removeAccount")}
                              aria-label={t("account.removeAccount")}
                              disabled={accountBusy}
                              onClick={() => {
                                void handleRemoveAccount(account.id);
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}

            <button
              type="button"
              className="btn btn-sm btn-ghost mt-2 w-full justify-start"
              disabled={accountBusy}
              onClick={() => setShowAddAccount(true)}
            >
              <Plus size={14} className="shrink-0" />
              <span>{t("account.addAccount")}</span>
            </button>

            <div className="divider my-2" />
            <button
              type="button"
              className="btn btn-sm btn-ghost justify-start text-error"
              onClick={onLogout}
            >
              <LogOut size={14} className="shrink-0" />
              <span>{t("header.signOut")}</span>
            </button>
          </div>
        </details>
      </div>

      {showAddAccount ? (
        <AddAccountModal
          accounts={accounts}
          onClose={() => setShowAddAccount(false)}
          onAdded={() => {
            // A freshly added account starts empty locally; pull its recent
            // library so its photos appear without requiring a manual sync.
            void invoke("check_for_new_assets").catch((err) =>
              console.error("[accounts] post-add quick sync failed", err),
            );
          }}
        />
      ) : null}
    </header>
  );
}
