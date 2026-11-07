import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useAlbumAccess } from "../../hooks/useAlbumAccess";
import { useAlbumAccessLabels } from "../../i18n/albumAccess";
import type { AlbumOwnerSummary } from "../../types";
import { personDetail, personLabel } from "../../utils/albumAccess";
import { AlbumAccessAddUser } from "./AlbumAccessAddUser";
import { AlbumAccessUserRow } from "./AlbumAccessUserRow";

interface AlbumAccessModalProps {
  albumId: string;
  albumName: string;
  ownerId: string;
  owner: AlbumOwnerSummary | null;
  onClose: () => void;
}

export function AlbumAccessModal({
  albumId,
  albumName,
  ownerId,
  owner,
  onClose,
}: AlbumAccessModalProps) {
  const labels = useAlbumAccessLabels();
  const access = useAlbumAccess(albumId, ownerId);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { online, loadState, members, busy } = access;
  const locked = !online || busy;
  const ownerPerson = owner ?? access.ownerPerson ?? { id: ownerId, name: null, email: null };
  const ownerDetail = personDetail(ownerPerson);
  // The offline notice already says this, so don't repeat it as an error.
  const error = !online && access.error === labels.offline ? null : access.error;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      aria-busy={busy}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-box w-full max-w-xl">
        <h3 id={titleId} className="text-lg font-semibold">
          {labels.title}
        </h3>
        <p className="mt-1 truncate text-sm text-base-content/70" title={albumName}>
          {albumName}
        </p>

        <div className="mt-4 space-y-4">
          {!online ? (
            <p role="status" className="text-sm text-base-content/70">
              {labels.offline}
            </p>
          ) : null}

          {online && loadState === "loading" ? (
            <p role="status" className="flex items-center gap-2 text-sm text-base-content/70">
              <span className="loading loading-spinner loading-sm" aria-hidden="true" />
              {labels.loading}
            </p>
          ) : null}

          {online && loadState === "failed" ? (
            <div className="space-y-2">
              {error ? (
                <p role="alert" className="text-sm text-error">
                  {error}
                </p>
              ) : null}
              <button type="button" className="btn btn-sm" onClick={() => void access.reload()}>
                {labels.retry}
              </button>
            </div>
          ) : null}

          {loadState === "ready" ? (
            <>
              <section className="space-y-2">
                <h4 className="text-sm font-semibold">{labels.peopleHeading}</h4>
                <div className="max-h-72 overflow-y-auto rounded-box border border-base-300 bg-base-100">
                  <ul className="list p-2">
                    <li className="list-row items-center">
                      <div className="list-col-grow min-w-0">
                        <div className="truncate text-sm font-medium">
                          {personLabel(ownerPerson)}
                        </div>
                        {ownerDetail ? (
                          <div className="truncate text-xs text-base-content/60">{ownerDetail}</div>
                        ) : null}
                      </div>
                      <span className="badge badge-ghost">{labels.owner}</span>
                    </li>
                    {members.map((member) => (
                      <AlbumAccessUserRow
                        key={member.id}
                        member={member}
                        working={access.workingUserId === member.id}
                        locked={locked}
                        confirmingRemoval={access.pendingRemovalId === member.id}
                        onRoleChange={(role) => void access.changeRole(member.id, role)}
                        onRequestRemoval={() => access.requestRemoval(member.id)}
                        onCancelRemoval={() => access.requestRemoval(null)}
                        onConfirmRemoval={() => void access.removeUser(member.id)}
                      />
                    ))}
                  </ul>
                </div>
                {members.length === 0 ? (
                  <p className="text-sm text-base-content/70">{labels.noPeople}</p>
                ) : null}
              </section>
              <AlbumAccessAddUser
                candidates={access.addable}
                adding={access.adding}
                locked={locked}
                onAdd={access.addUser}
              />
              <p className="text-xs text-base-content/60">{labels.roleHelp}</p>
            </>
          ) : null}

          {loadState === "ready" && error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}
        </div>

        <div className="modal-action">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {labels.close}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" disabled={busy} onClick={onClose} aria-label={labels.close}>
          {labels.close}
        </button>
      </form>
    </dialog>,
    document.body,
  );
}
