import { FolderCog, FolderInput, FolderPlus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ismCreateFolder,
  ismFolderLocation,
  ismFolderSnapshot,
  ismMoveFolder,
  ismTrashFolder,
  type IsmExpectedEntry,
  type IsmLocation,
} from "../../api/ism";
import { useIsmLabels } from "../../i18n/ism";
import { toast } from "../../toasts/toast";
import { ismErrorMessage } from "../../utils/ismErrors";
import { isPendingIsmOperation } from "./IsmAssetActions";
import { IsmDialog } from "./IsmDialog";

type Dialog = "create" | "move" | "trash";

type Props = {
  accountId: string;
  /** Immich folder path shown in the folder view. */
  path: string;
  onChanged: () => void;
  /** The shown folder no longer exists at this path (moved or trashed). */
  onLeft: () => void;
};

/** Folder management through ISM, shown only when an ISM root covers the folder. */
export function IsmFolderActions({ accountId, path, onChanged, onLeft }: Props) {
  const labels = useIsmLabels();
  const [location, setLocation] = useState<IsmLocation | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [value, setValue] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<IsmExpectedEntry[] | null>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    let active = true;
    setLocation(null);
    ismFolderLocation(accountId, path)
      .then((found) => {
        if (active) setLocation(found);
      })
      .catch((err) => console.warn("[ism] cannot map folder to ISM", err));
    return () => {
      active = false;
    };
  }, [accountId, path]);

  if (!location) return null;
  const isRoot = location.path === "";

  const open = (next: Dialog) => {
    if (menuRef.current) menuRef.current.open = false;
    setValue(next === "move" ? location.path : "");
    setError(null);
    setEntries(null);
    setDialog(next);
    if (next !== "trash") return;
    setWorking(true);
    ismFolderSnapshot(accountId, location.root_id, location.path)
      .then(setEntries)
      .catch((err) => {
        console.error("[ism] cannot list folder before trashing", err);
        setError(ismErrorMessage(err, labels.errors));
      })
      .finally(() => setWorking(false));
  };

  const submit = async () => {
    const input = value.trim().replace(/^\/+|\/+$/g, "");
    if (dialog !== "trash" && !input) return;
    if (dialog === "trash" && !entries) return;
    setWorking(true);
    setError(null);
    try {
      const operation =
        dialog === "create"
          ? await ismCreateFolder(
              accountId,
              location.root_id,
              isRoot ? input : `${location.path}/${input}`,
            )
          : dialog === "move"
            ? await ismMoveFolder(
                accountId,
                location.root_id,
                location.path,
                location.root_id,
                input,
              )
            : await ismTrashFolder(accountId, location.root_id, location.path, entries ?? []);
      if (isPendingIsmOperation(operation)) toast.info("ism.pending");
      else toast.success("ism.folderChanged");
      setDialog(null);
      if (dialog === "create") onChanged();
      else onLeft();
    } catch (err) {
      console.error("[ism] folder operation failed", { dialog, err });
      setError(ismErrorMessage(err, labels.errors));
    } finally {
      setWorking(false);
    }
  };

  const title =
    dialog === "create"
      ? labels.createFolder
      : dialog === "move"
        ? labels.moveFolder
        : labels.trashFolder;

  return (
    <>
      <details ref={menuRef} className="dropdown dropdown-end ml-auto">
        <summary className="btn btn-sm btn-ghost gap-1" aria-label={labels.folderActions}>
          <FolderCog size={16} />
          <span className="hidden sm:inline">{labels.folderActions}</span>
        </summary>
        <ul className="menu dropdown-content z-[130] mt-2 w-64 rounded-box border border-base-300 bg-base-100 p-1 shadow">
          <li>
            <button type="button" onClick={() => open("create")}>
              <FolderPlus size={16} />
              {labels.createFolder}
            </button>
          </li>
          {!isRoot && (
            <>
              <li>
                <button type="button" onClick={() => open("move")}>
                  <FolderInput size={16} />
                  {labels.moveFolder}
                </button>
              </li>
              <li>
                <button type="button" onClick={() => open("trash")}>
                  <Trash2 size={16} />
                  {labels.trashFolder}
                </button>
              </li>
            </>
          )}
        </ul>
      </details>
      {dialog ? (
        <IsmDialog
          title={title.replace(/…$/, "")}
          zIndexClass="z-[120]"
          working={working}
          error={error}
          labels={labels}
          danger={dialog === "trash"}
          canConfirm={dialog === "trash" ? entries !== null : value.trim().length > 0}
          onCancel={() => {
            if (!working) setDialog(null);
          }}
          onConfirm={() => void submit()}
        >
          {dialog === "trash" ? (
            <div className="space-y-2 text-sm text-base-content/80">
              <p>{labels.trashFolderBody(location.path)}</p>
              <p>{entries ? labels.trashFolderCount(entries.length) : labels.trashFolderLoading}</p>
            </div>
          ) : (
            <label className="form-control w-full">
              <span className="label-text mb-1">
                {dialog === "create" ? labels.folderName : labels.newFolderPath}
              </span>
              <input
                className="input input-bordered w-full"
                value={value}
                autoFocus
                disabled={working}
                onChange={(event) => setValue(event.target.value)}
              />
              <span className="mt-1 text-xs text-base-content/60">
                {dialog === "create"
                  ? labels.createFolderHint(location.path)
                  : labels.moveFolderHint}
              </span>
            </label>
          )}
        </IsmDialog>
      ) : null}
    </>
  );
}
