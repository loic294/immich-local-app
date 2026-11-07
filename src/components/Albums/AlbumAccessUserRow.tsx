import { useEffect, useRef } from "react";
import { useAlbumAccessLabels } from "../../i18n/albumAccess";
import type { AlbumShareUser, AlbumUserRole } from "../../types";
import { personDetail, personLabel, toAlbumUserRole } from "../../utils/albumAccess";

interface AlbumAccessUserRowProps {
  member: AlbumShareUser;
  /** This member's change is in flight. */
  working: boolean;
  /** Another change is in flight, or the server is unreachable. */
  locked: boolean;
  confirmingRemoval: boolean;
  onRoleChange: (role: AlbumUserRole) => void;
  onRequestRemoval: () => void;
  onCancelRemoval: () => void;
  onConfirmRemoval: () => void;
}

export function AlbumAccessUserRow({
  member,
  working,
  locked,
  confirmingRemoval,
  onRoleChange,
  onRequestRemoval,
  onCancelRemoval,
  onConfirmRemoval,
}: AlbumAccessUserRowProps) {
  const labels = useAlbumAccessLabels();
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingRef = useRef(false);
  const name = personLabel(member);
  const detail = personDetail(member);
  const role = toAlbumUserRole(member.role);
  const disabled = working || locked;

  // The button that opened the confirmation unmounts, so hand focus to the safe
  // choice and take it back to the Remove button when the confirmation closes.
  useEffect(() => {
    if (confirmingRemoval) {
      cancelButtonRef.current?.focus();
    } else if (wasConfirmingRef.current) {
      removeButtonRef.current?.focus();
    }
    wasConfirmingRef.current = confirmingRemoval;
  }, [confirmingRemoval]);

  return (
    <li className="list-row items-center" aria-busy={working}>
      <div className="list-col-grow min-w-0">
        <div className="truncate text-sm font-medium">{name}</div>
        {detail ? <div className="truncate text-xs text-base-content/60">{detail}</div> : null}
      </div>
      <select
        className="select select-sm w-28"
        value={role ?? member.role ?? ""}
        disabled={disabled || confirmingRemoval}
        aria-label={`${name} – ${labels.permission}`}
        onChange={(event) => {
          const next = toAlbumUserRole(event.target.value);
          if (next && next !== role) onRoleChange(next);
        }}
      >
        {role === null ? (
          <option value={member.role ?? ""} disabled>
            {member.role ?? "—"}
          </option>
        ) : null}
        <option value="editor">{labels.editor}</option>
        <option value="viewer">{labels.viewer}</option>
      </select>
      {confirmingRemoval ? (
        <div className="flex items-center gap-1">
          <span className="text-xs text-base-content/70">{labels.removeConfirm}</span>
          <button
            type="button"
            className="btn btn-xs btn-error"
            disabled={disabled}
            aria-label={`${labels.remove} – ${name}`}
            onClick={onConfirmRemoval}
          >
            {working ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : null}
            {labels.remove}
          </button>
          <button
            ref={cancelButtonRef}
            type="button"
            className="btn btn-xs btn-ghost"
            disabled={working}
            onClick={onCancelRemoval}
          >
            {labels.cancel}
          </button>
        </div>
      ) : (
        <button
          ref={removeButtonRef}
          type="button"
          className="btn btn-xs btn-ghost text-error"
          disabled={disabled}
          aria-label={`${labels.remove} – ${name}`}
          onClick={onRequestRemoval}
        >
          {labels.remove}
        </button>
      )}
    </li>
  );
}
