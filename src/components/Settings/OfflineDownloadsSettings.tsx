import { useEffect, useState } from "react";
import type { Account } from "../../api/tauri";
import {
  dismissIsmActivity,
  getIsmImportFolder,
  getIsmProvider,
  ismCreateFolder,
  ismFolderSnapshot,
  ismMoveFolder,
  ismTrashFolder,
  listIsmActivity,
  removeIsmProvider,
  saveIsmProvider,
  setIsmImportFolder,
  testIsmProvider,
  type IsmActivity,
  type IsmExpectedEntry,
  type IsmInfo,
} from "../../api/ism";
import { useI18n } from "../../i18n";

type Roots = IsmInfo["roots"];

const WRITE_BLOCK_REASONS = [
  "not_configured",
  "unknown_server",
  "drift",
  "maintenance",
  "recovery_required",
];

function writesLabel(
  root: Roots[number],
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (root.direct_writes === "enabled") return t("settings.ismWritesEnabled");
  if (root.direct_writes === "not_linked") return t("settings.ismWritesNotLinked");
  const reason = root.direct_writes_reason ?? "";
  const label = WRITE_BLOCK_REASONS.includes(reason)
    ? t(`settings.ismWritesReason_${reason}`)
    : t("settings.ismWritesBlocked");
  return root.direct_writes_detail ? `${label} (${root.direct_writes_detail})` : label;
}

function RootField({
  label,
  roots,
  value,
  disabled,
  onChange,
}: {
  label: string;
  roots: Roots;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="fieldset">
      <span className="fieldset-legend">{label}</span>
      {roots.length > 0 ? (
        <select
          className="select w-full"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          <option value="">—</option>
          {roots.map((root) => (
            <option key={root.root_id} value={root.root_id}>
              {root.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input w-full"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </label>
  );
}

function ServerManagement({ account, roots }: { account: Account; roots: Roots }) {
  const { t } = useI18n();
  const [importRoot, setImportRoot] = useState("");
  const [importPath, setImportPath] = useState("");
  const [folderRoot, setFolderRoot] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [trashEntries, setTrashEntries] = useState<IsmExpectedEntry[] | null>(null);

  useEffect(() => setTrashEntries(null), [folderRoot, folderPath]);

  useEffect(() => {
    let active = true;
    void getIsmImportFolder(account.id)
      .then((folder) => {
        if (!active) return;
        setImportRoot(folder?.root_id ?? "");
        setImportPath(folder?.path ?? "");
      })
      .catch((err) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [account.id]);

  const run = async (action: () => Promise<unknown>, done: string | null) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(t(done));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveImport = () =>
    run(
      () =>
        setIsmImportFolder(
          account.id,
          importRoot.trim() ? { root_id: importRoot, path: importPath } : null,
        ),
      "settings.ismImportSaved",
    );
  const folderReady = !busy && folderRoot.trim() !== "" && folderPath.trim() !== "";

  return (
    <div className="space-y-3">
      <h4 className="font-semibold">{t("settings.ismImportTitle")}</h4>
      <p className="text-sm text-base-content/70">{t("settings.ismImportDescription")}</p>
      <RootField
        label={t("settings.ismRoot")}
        roots={roots}
        value={importRoot}
        disabled={busy}
        onChange={setImportRoot}
      />
      <label className="fieldset">
        <span className="fieldset-legend">{t("settings.ismFolder")}</span>
        <input
          className="input w-full"
          value={importPath}
          disabled={busy}
          placeholder="Imports/Desktop"
          onChange={(event) => setImportPath(event.currentTarget.value)}
        />
      </label>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => void saveImport()}
      >
        {t("settings.ismImportSave")}
      </button>
      <h4 className="font-semibold">{t("settings.ismFoldersTitle")}</h4>
      <RootField
        label={t("settings.ismRoot")}
        roots={roots}
        value={folderRoot}
        disabled={busy}
        onChange={setFolderRoot}
      />
      <label className="fieldset">
        <span className="fieldset-legend">{t("settings.ismFolder")}</span>
        <input
          className="input w-full"
          value={folderPath}
          disabled={busy}
          onChange={(event) => setFolderPath(event.currentTarget.value)}
        />
      </label>
      <label className="fieldset">
        <span className="fieldset-legend">{t("settings.ismFolderTarget")}</span>
        <input
          className="input w-full"
          value={targetPath}
          disabled={busy}
          onChange={(event) => setTargetPath(event.currentTarget.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!folderReady}
          onClick={() =>
            void run(
              () => ismCreateFolder(account.id, folderRoot, folderPath),
              "settings.ismFolderDone",
            )
          }
        >
          {t("settings.ismFolderCreate")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!folderReady || !targetPath.trim()}
          onClick={() =>
            void run(
              () => ismMoveFolder(account.id, folderRoot, folderPath, folderRoot, targetPath),
              "settings.ismFolderDone",
            )
          }
        >
          {t("settings.ismFolderMove")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm text-error"
          disabled={!folderReady}
          onClick={() =>
            void run(
              async () =>
                setTrashEntries(await ismFolderSnapshot(account.id, folderRoot, folderPath)),
              null,
            )
          }
        >
          {t("settings.ismFolderTrash")}
        </button>
      </div>
      {trashEntries && (
        <div role="alert" className="space-y-2 rounded-box border border-error/40 p-3 text-sm">
          <p>
            {t("settings.ismFolderTrashConfirm", {
              path: folderPath.trim(),
              count: String(trashEntries.length),
            })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-error btn-sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await ismTrashFolder(account.id, folderRoot, folderPath, trashEntries);
                  setTrashEntries(null);
                }, "settings.ismFolderDone")
              }
            >
              {t("settings.ismFolderTrashConfirmButton")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => setTrashEntries(null)}
            >
              {t("settings.ismFolderTrashCancel")}
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}

function IsmActivityList() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<IsmActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    void listIsmActivity()
      .then((result) => {
        if (active) setEntries(result);
      })
      .catch((err) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [version]);

  const dismiss = async (id: string) => {
    try {
      await dismissIsmActivity(id);
      setVersion((value) => value + 1);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="space-y-2 border-t border-base-300 pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{t("settings.ismActivityTitle")}</h3>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setVersion((value) => value + 1)}
        >
          {t("settings.ismActivityRefresh")}
        </button>
      </div>
      {entries.length === 0 && (
        <p className="text-sm text-base-content/70">{t("settings.ismActivityEmpty")}</p>
      )}
      <ul className="space-y-1 text-sm">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-start justify-between gap-2">
            <span className="break-words">
              {entry.label || entry.kind} · {entry.status}
              {entry.error && <span className="block text-error">{entry.error}</span>}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => void dismiss(entry.id)}
            >
              {t("settings.ismActivityDismiss")}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="break-words text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}

function ServerDownloads({ account }: { account: Account }) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<IsmInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoaded(false);
    setError(null);
    void getIsmProvider(account.id)
      .then((provider) => {
        if (!active) return;
        setUrl(provider?.baseUrl ?? "");
        setConfigured(provider !== null);
        setLoaded(true);
      })
      .catch((err) => {
        if (active) setError(String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [account.id, loadVersion]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveIsmProvider(account.id, url, token || null);
      setInfo(result);
      setConfigured(true);
      setToken("");
      setNotice(t("settings.ismConnected", { name: result.instance_name }));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await testIsmProvider(account.id);
      setInfo(result);
      setNotice(t("settings.ismConnected", { name: result.instance_name }));
    } catch (err) {
      setInfo(null);
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await removeIsmProvider(account.id);
      setConfigured(false);
      setToken("");
      setUrl("");
      setInfo(null);
      setNotice(t("settings.ismRemoved"));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-base-300 pt-4">
      <div>
        <h3 className="break-all font-semibold">{account.serverUrl}</h3>
        <p className="text-sm text-base-content/70">
          {loading
            ? t("settings.ismLoading")
            : loaded
              ? configured
                ? t("settings.ismUsing")
                : t("settings.ismDefault")
              : t("settings.ismLoadFailed")}
        </p>
      </div>
      <label className="fieldset">
        <span className="fieldset-legend">{t("settings.ismUrl")}</span>
        <input
          className="input w-full"
          type="url"
          value={url}
          disabled={!loaded || busy}
          autoComplete="url"
          placeholder="https://sync.example"
          onChange={(event) => {
            setUrl(event.currentTarget.value);
            setInfo(null);
            setNotice(null);
          }}
        />
      </label>
      <label className="fieldset">
        <span className="fieldset-legend">{t("settings.ismToken")}</span>
        <input
          className="input w-full"
          type="password"
          value={token}
          disabled={!loaded || busy}
          autoComplete="new-password"
          placeholder={configured ? t("settings.ismTokenUnchanged") : ""}
          onChange={(event) => {
            setToken(event.currentTarget.value);
            setNotice(null);
          }}
        />
      </label>
      <p className="text-sm text-base-content/70">{t("settings.ismTokenStorage")}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!loaded || busy || !url.trim()}
          onClick={() => void save()}
        >
          {busy ? t("settings.saving") : t("settings.ismSave")}
        </button>
        {configured && (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={loading || busy}
              onClick={() => void test()}
            >
              {t("settings.ismTest")}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={loading || busy}
              onClick={() => void remove()}
            >
              {t("settings.ismUseImmich")}
            </button>
          </>
        )}
      </div>
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-error">
          {error}
        </p>
      )}
      {!loading && !loaded && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setLoadVersion((version) => version + 1)}
        >
          {t("settings.ismRetry")}
        </button>
      )}
      {configured && loaded && <ServerManagement account={account} roots={info?.roots ?? []} />}
      {info && (
        <ul className="space-y-1 text-sm">
          {info.roots.map((root) => (
            <li key={root.root_id}>
              {root.name}: {t(root.available ? "settings.ismAvailable" : "settings.ismUnavailable")}
              {" · "}
              {writesLabel(root, t)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OfflineDownloadsSettings({ accounts }: { accounts: Account[] }) {
  const { t } = useI18n();
  const seen = new Set<string>();
  const servers = accounts.filter((account) => {
    const key = account.serverUrl.replace(/\/+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <section className="card mb-6 border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body">
        <h2 className="card-title">{t("settings.ismTitle")}</h2>
        <p className="text-sm text-base-content/70">{t("settings.ismDescription")}</p>
        <p className="text-sm text-base-content/70">{t("settings.ismLimitations")}</p>
        {servers.length === 0 && <p className="text-sm">{t("settings.ismNoAccounts")}</p>}
        {servers.map((account) => (
          <ServerDownloads key={account.serverUrl} account={account} />
        ))}
        {servers.length > 0 && <IsmActivityList />}
      </div>
    </section>
  );
}
