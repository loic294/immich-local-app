import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { getPersonThumbnail } from "../../api/tauri";
import { PageBackButton } from "../Layout/PageBackButton";
import { useBrowsingI18n } from "../../i18n/browsing";
import type { BrowsingPerson } from "../../types/browsing";

interface PersonHeaderProps {
  person: BrowsingPerson;
  onBack: () => void;
}

export function PersonHeader({ person, onBack }: PersonHeaderProps) {
  const t = useBrowsingI18n();
  const thumbnail = useQuery({
    queryKey: ["person-thumbnail", person.id],
    queryFn: () => getPersonThumbnail(person.id),
    staleTime: Infinity,
    retry: false,
  });
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <PageBackButton ariaLabel={t("backPeople")} onClick={onBack} />
        <div className="avatar shrink-0">
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-base-300">
            {thumbnail.data ? <img src={thumbnail.data} alt="" /> : <UserRound size={24} />}
          </div>
        </div>
        <h1 className="m-0 truncate text-xl font-bold text-base-content">
          {person.name?.trim() || t("unnamed")}
        </h1>
      </div>
      <span className="shrink-0 text-sm text-base-content/60">
        {person.assetCount} {t("photos")}
      </span>
    </div>
  );
}
