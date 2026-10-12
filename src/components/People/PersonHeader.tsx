import { useMutation, useQueryClient } from "@tanstack/react-query";
import { changePerson } from "../../api/browsing";
import { useConnectionContext } from "../../hooks/connectionContext";
import { PersonThumbnail } from "./PersonThumbnail";
import { PageBackButton } from "../Layout/PageBackButton";
import { useBrowsingI18n } from "../../i18n/browsing";
import type { BrowsingPerson } from "../../types/browsing";

interface PersonHeaderProps {
  person: BrowsingPerson;
  onBack: () => void;
  onAssign: () => void;
}

export function PersonHeader({ person, onBack, onAssign }: PersonHeaderProps) {
  const t = useBrowsingI18n();
  const { isOnline } = useConnectionContext();
  const queryClient = useQueryClient();
  const hide = useMutation({
    mutationFn: async () => {
      if (isOnline !== true) throw new Error(t("peopleMutationOffline"));
      await changePerson(person.accountId, person.id, "hide");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["browsing-people"] });
      await queryClient.invalidateQueries({ queryKey: ["browsing-named-people"] });
      await queryClient.invalidateQueries({ queryKey: ["people-in-scope"] });
      onBack();
    },
    onError: (error) =>
      console.warn("[browsing.people] hide failed", { personId: person.id, error }),
  });
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <PageBackButton ariaLabel={t("backPeople")} onClick={onBack} />
          <div className="avatar shrink-0">
            <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-base-300">
              <PersonThumbnail person={person} />
            </div>
          </div>
          <h1 className="m-0 truncate text-xl font-bold text-base-content">
            {person.name?.trim() || (
              <button type="button" className="link link-hover" onClick={onAssign}>
                {t("unnamed")}
              </button>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-sm text-base-content/60">
            {person.assetCount} {t("photos")}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={isOnline !== true || hide.isPending}
            title={isOnline !== true ? t("peopleMutationOffline") : t("hidePerson")}
            onClick={() => hide.mutate()}
          >
            {t("hidePerson")}
          </button>
        </div>
      </div>
      {isOnline !== true ? (
        <p className="text-sm text-base-content/60">{t("peopleMutationOffline")}</p>
      ) : null}
      {hide.error ? (
        <div className="alert alert-error" role="alert">
          {String(hide.error).includes("offline:")
            ? t("peopleMutationOffline")
            : String(hide.error)}
        </div>
      ) : null}
    </div>
  );
}
