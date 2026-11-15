import { FolderInput, PencilLine, Trash2 } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  ismMoveAsset,
  ismRenameAsset,
  ismSupportedAssets,
  ismTrashAsset,
  type IsmOperation,
} from "../../api/ism";
import { useIsmLabels } from "../../i18n/ism";
import { toast } from "../../toasts/toast";
import { ismErrorMessage } from "../../utils/ismErrors";
import { IsmDialog } from "./IsmDialog";

type Dialog = "rename" | "move" | "trash";

type Options = {
  selectedAssetIds: string[];
  modalZIndexClass: string;
  stopPropagation: boolean;
  closeMenu: () => void;
  onCompleted?: () => void;
};

export const isPendingIsmOperation = (operation: IsmOperation) =>
  ["queued", "waiting_maintenance", "running"].includes(operation.status);

/** ISM file actions for the selected assets, offered only when all of them use ISM. */
export function useIsmAssetActions({
  selectedAssetIds,
  modalZIndexClass,
  stopPropagation,
  closeMenu,
  onCompleted,
}: Options): { available: boolean; menuItems: ReactNode; dialog: ReactNode } {
  const labels = useIsmLabels();
  const [supported, setSupported] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [value, setValue] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectionKey = selectedAssetIds.join("\n");

  useEffect(() => {
    let active = true;
    const ids = selectionKey ? selectionKey.split("\n") : [];
    if (ids.length === 0) {
      setSupported(false);
      return;
    }
    ismSupportedAssets(ids)
      .then((found) => {
        if (active) setSupported(ids.every((id) => found.includes(id)));
      })
      .catch((err) => {
        console.warn("[ism] cannot check ISM support", err);
        if (active) setSupported(false);
      });
    return () => {
      active = false;
    };
  }, [selectionKey]);

  const open = (event: MouseEvent<HTMLElement>, next: Dialog) => {
    if (stopPropagation) event.stopPropagation();
    closeMenu();
    setValue("");
    setError(null);
    setDialog(next);
  };

  const submit = async () => {
    if (!dialog) return;
    const ids = [...selectedAssetIds];
    const input = value.trim();
    if (dialog !== "trash" && !input) return;
    setWorking(true);
    setError(null);
    let done = 0;
    let pending = false;
    try {
      // One operation per photo; stop at the first refusal so nothing is retried blindly.
      for (const id of ids) {
        const operation =
          dialog === "rename"
            ? await ismRenameAsset(id, input)
            : dialog === "move"
              ? await ismMoveAsset(id, null, input)
              : await ismTrashAsset(id);
        pending ||= isPendingIsmOperation(operation);
        done += 1;
      }
      if (pending) toast.info("ism.pending");
      else if (dialog === "rename") toast.success("ism.renamed", { name: input });
      else if (dialog === "move") toast.success("ism.moved", { count: done });
      else toast.success("ism.trashed", { count: done });
      setDialog(null);
      onCompleted?.();
    } catch (err) {
      console.error("[ism] asset operation failed", { dialog, done, err });
      const message = ismErrorMessage(err, labels.errors);
      setError(done > 0 ? `${message} ${labels.partial(done, ids.length)}` : message);
    } finally {
      setWorking(false);
    }
  };

  const available = supported && selectedAssetIds.length > 0;
  const menuItems = available ? (
    <>
      {selectedAssetIds.length === 1 && (
        <li>
          <button type="button" data-test="ism-rename" onClick={(e) => open(e, "rename")}>
            <PencilLine size={16} />
            {labels.rename}
          </button>
        </li>
      )}
      <li>
        <button type="button" data-test="ism-move" onClick={(e) => open(e, "move")}>
          <FolderInput size={16} />
          {labels.move}
        </button>
      </li>
      <li>
        <button type="button" data-test="ism-trash" onClick={(e) => open(e, "trash")}>
          <Trash2 size={16} />
          {labels.trash}
        </button>
      </li>
    </>
  ) : null;

  const title =
    dialog === "rename"
      ? labels.renameTitle
      : dialog === "move"
        ? labels.moveTitle
        : labels.trashTitle;
  const dialogNode = dialog ? (
    <IsmDialog
      title={title}
      zIndexClass={modalZIndexClass}
      stopPropagation={stopPropagation}
      working={working}
      error={error}
      labels={labels}
      danger={dialog === "trash"}
      canConfirm={dialog === "trash" || value.trim().length > 0}
      onCancel={() => {
        if (!working) setDialog(null);
      }}
      onConfirm={() => void submit()}
    >
      {dialog === "trash" ? (
        <p className="text-sm text-base-content/80">{labels.trashBody(selectedAssetIds.length)}</p>
      ) : (
        <label className="form-control w-full">
          <span className="label-text mb-1">
            {dialog === "rename" ? labels.fileName : labels.folder}
          </span>
          <input
            className="input input-bordered w-full"
            value={value}
            autoFocus
            disabled={working}
            onChange={(event) => setValue(event.target.value)}
          />
          <span className="mt-1 text-xs text-base-content/60">
            {dialog === "rename" ? labels.renameHint : labels.moveHint}
          </span>
        </label>
      )}
    </IsmDialog>
  ) : null;

  return { available, menuItems, dialog: dialogNode };
}
