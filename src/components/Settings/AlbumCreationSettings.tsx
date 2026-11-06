import { useId } from "react";
import type { Account } from "../../api/tauri";
import { useAlbumCreationSettings } from "../../hooks/useAlbumCreationSettings";
import { useAlbumCreationLabels } from "../../i18n/albumCreation";
import type { Settings } from "../../types";

interface AlbumCreationSettingsProps {
  settings: Settings;
  accounts: Account[];
  onSaved: (settings: Settings) => void;
}

export function AlbumCreationSettings({ settings, accounts, onSaved }: AlbumCreationSettingsProps) {
  const labels = useAlbumCreationLabels();
  const form = useAlbumCreationSettings(settings, accounts, onSaved);
  const helpId = useId();
  const hasOwner = accounts.some((account) => account.id === form.ownerAccountId);

  return (
    <div className="card border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body gap-4">
        <div>
          <h2 className="card-title">{labels.title}</h2>
          <p className="text-sm text-base-content/70">{labels.description}</p>
        </div>
        <label className="fieldset">
          <span className="fieldset-legend">{labels.owner}</span>
          <select
            className="select w-full"
            value={hasOwner ? form.ownerAccountId : ""}
            disabled={form.saving}
            onChange={(event) => form.changeOwner(event.currentTarget.value)}
          >
            {!hasOwner && <option value="">{labels.missingOwner}</option>}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.userName || account.userEmail || account.userId}
                {" — "}
                {account.serverUrl}
              </option>
            ))}
          </select>
        </label>
        <fieldset
          className="fieldset"
          disabled={form.saving || !hasOwner}
          aria-describedby={helpId}
        >
          <legend className="fieldset-legend">{labels.editors}</legend>
          <p id={helpId} className="text-sm text-base-content/70">
            {labels.editorHelp}
          </p>
          <div className="my-2 flex max-h-80 flex-col gap-3 overflow-y-auto">
            {form.candidates.map((user) => (
              <label key={user.id} className="label cursor-pointer whitespace-normal">
                <input
                  type="checkbox"
                  className="checkbox checkbox-primary"
                  checked={form.editorUserIds.includes(user.id)}
                  onChange={() => form.toggleEditor(user.id)}
                />
                <span className="min-w-0 break-words">
                  {user.name || user.email || user.id}
                  {user.name && user.email && (
                    <span className="block text-xs text-base-content/60">{user.email}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
          {form.loading && <p role="status">{labels.loading}</p>}
          {!form.loading && !form.loadingError && form.candidates.length === 0 && (
            <p>{labels.empty}</p>
          )}
        </fieldset>
        {form.loadingError && (
          <div role="alert" className="alert alert-warning">
            <div className="min-w-0 break-words">
              <p>{labels.loadFailed}</p>
              <p className="text-xs">{form.loadingError}</p>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={form.loading || form.saving}
              onClick={form.reload}
            >
              {labels.retry}
            </button>
          </div>
        )}
        <p className="text-sm text-base-content/70">{labels.contributionHelp}</p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary"
            disabled={form.saving || !hasOwner}
            onClick={() => void form.save()}
          >
            {form.saving ? labels.saving : labels.save}
          </button>
          {form.saved && (
            <p role="status" className="text-sm text-success">
              {labels.saved}
            </p>
          )}
        </div>
        {form.saveError && (
          <p role="alert" className="text-sm text-error">
            {labels.saveFailed} {form.saveError}
          </p>
        )}
      </div>
    </div>
  );
}
