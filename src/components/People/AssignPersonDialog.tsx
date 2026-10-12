import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { changePerson, refreshPeople } from "../../api/browsing";
import { useConnectionContext } from "../../hooks/connectionContext";
import { useNamedPeople } from "../../hooks/usePeople";
import { useBrowsingI18n } from "../../i18n/browsing";
import type { BrowsingPerson } from "../../types/browsing";
import { visiblePeople } from "../../utils/people";
import { PersonThumbnail } from "./PersonThumbnail";

interface AssignPersonDialogProps {
  person: BrowsingPerson;
  onClose: () => void;
  onAssigned: () => void;
}

export function AssignPersonDialog({ person, onClose, onAssigned }: AssignPersonDialogProps) {
  const t = useBrowsingI18n();
  const { isOnline } = useConnectionContext();
  const queryClient = useQueryClient();
  const people = useNamedPeople(person.accountId);
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const targets = visiblePeople(
    (people.data ?? []).filter(
      (candidate) => candidate.accountId === person.accountId && candidate.id !== person.id,
    ),
    name,
    true,
    "name",
    t("unnamed"),
  );
  const mutation = useMutation({
    mutationFn: async (action: "name" | "merge") => {
      if (isOnline !== true) throw new Error(t("peopleMutationOffline"));
      console.log("[browsing.people] assign start", { personId: person.id, action });
      await changePerson(person.accountId, person.id, action, name.trim(), targetId ?? undefined);
    },
    onSuccess: async () => {
      console.log("[browsing.people] assign complete", { personId: person.id });
      await queryClient.invalidateQueries({ queryKey: ["browsing-people"] });
      await queryClient.invalidateQueries({ queryKey: ["browsing-named-people"] });
      await queryClient.invalidateQueries({ queryKey: ["people-in-scope"] });
      onAssigned();
    },
    onError: async (error) => {
      console.warn("[browsing.people] assignment failed", error);
      if (String(error).includes("offline:")) return;
      try {
        await refreshPeople();
        await queryClient.invalidateQueries({ queryKey: ["browsing-people"] });
        await queryClient.invalidateQueries({ queryKey: ["browsing-named-people"] });
      } catch (refreshError) {
        console.warn("[browsing.people] refresh after rejected assignment failed", refreshError);
      }
    },
  });
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const disabled = isOnline !== true || mutation.isPending;
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="assign-person-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!mutation.isPending) onClose();
      }}
    >
      <div className="modal-box flex max-h-[85vh] flex-col">
        <h2 id="assign-person-title" className="mb-3 text-xl font-semibold">
          {t("assignPerson")}
        </h2>
        <p className="mb-3 text-sm text-base-content/70">{t("assignPersonHelp")}</p>
        {isOnline !== true ? (
          <div className="alert alert-info mb-3">{t("peopleMutationOffline")}</div>
        ) : null}
        <label className="fieldset">
          <span className="fieldset-legend">{t("personName")}</span>
          <input
            className="input w-full"
            autoFocus
            value={name}
            placeholder={t("searchPeople")}
            disabled={mutation.isPending}
            onChange={(event) => {
              setName(event.target.value);
              setTargetId(null);
              mutation.reset();
            }}
          />
        </label>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {people.isPending ? <span className="loading loading-spinner" /> : null}
          {people.error ? (
            <div role="alert" className="alert alert-error">
              {String(people.error)}
            </div>
          ) : null}
          {targets.length === 0 ? (
            <p className="py-3 text-sm text-base-content/60">{t("noNamedPeople")}</p>
          ) : null}
          <div className="flex flex-col gap-2" role="group" aria-label={t("searchPeople")}>
            {targets.map((target) => (
              <button
                key={target.id}
                type="button"
                className={`btn h-auto min-h-14 justify-start ${targetId === target.id ? "btn-primary" : "btn-ghost"}`}
                aria-pressed={targetId === target.id}
                disabled={mutation.isPending}
                onClick={() => {
                  setTargetId(target.id);
                  mutation.reset();
                }}
              >
                <span className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-base-300">
                  <PersonThumbnail person={target} />
                </span>
                <span className="min-w-0 truncate">{target.name}</span>
              </button>
            ))}
          </div>
        </div>
        {mutation.error ? (
          <div role="alert" className="alert alert-error mt-3">
            {String(mutation.error).includes("offline:")
              ? t("peopleMutationOffline")
              : String(mutation.error)}
          </div>
        ) : null}
        <div className="modal-action flex-wrap">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled || !targetId}
            onClick={() => mutation.mutate("merge")}
          >
            {t("mergePerson")}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            disabled={disabled || !name.trim() || Boolean(targetId)}
            onClick={() => mutation.mutate("name")}
          >
            {t("createPerson")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
