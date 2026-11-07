import { useState, type FormEvent } from "react";
import { useAlbumAccessLabels } from "../../i18n/albumAccess";
import type { AlbumUserCandidate, AlbumUserRole } from "../../types";
import { personLabel, toAlbumUserRole } from "../../utils/albumAccess";

interface AlbumAccessAddUserProps {
  candidates: AlbumUserCandidate[];
  adding: boolean;
  /** Another change is in flight, or the server is unreachable. */
  locked: boolean;
  /** Resolves true once the person has been added. */
  onAdd: (userId: string, role: AlbumUserRole) => Promise<boolean>;
}

export function AlbumAccessAddUser({ candidates, adding, locked, onAdd }: AlbumAccessAddUserProps) {
  const labels = useAlbumAccessLabels();
  const [selectedId, setSelectedId] = useState("");
  const [role, setRole] = useState<AlbumUserRole>("editor");
  const selected = candidates.some((candidate) => candidate.id === selectedId) ? selectedId : "";
  const canAdd = selected !== "" && !adding && !locked;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canAdd) return;
    if (await onAdd(selected, role)) setSelectedId("");
  };

  return (
    <form className="space-y-2" onSubmit={(event) => void handleSubmit(event)}>
      <h4 className="text-sm font-semibold">{labels.addHeading}</h4>
      {candidates.length === 0 ? (
        <p className="text-sm text-base-content/70">{labels.noCandidates}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="select select-sm min-w-0 flex-1"
            value={selected}
            disabled={adding || locked}
            aria-label={labels.selectPerson}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            <option value="">{labels.selectPerson}</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {personLabel(candidate)}
              </option>
            ))}
          </select>
          <select
            className="select select-sm w-28"
            value={role}
            disabled={adding || locked}
            aria-label={labels.permission}
            onChange={(event) => setRole(toAlbumUserRole(event.target.value) ?? "editor")}
          >
            <option value="editor">{labels.editor}</option>
            <option value="viewer">{labels.viewer}</option>
          </select>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!canAdd}>
            {adding ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : null}
            {adding ? labels.adding : labels.add}
          </button>
        </div>
      )}
    </form>
  );
}
