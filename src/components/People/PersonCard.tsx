import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { getPersonThumbnail } from "../../api/tauri";
import { useBrowsingI18n } from "../../i18n/browsing";
import type { BrowsingPerson } from "../../types/browsing";

interface PersonCardProps {
  person: BrowsingPerson;
  onClick: () => void;
}

export function PersonCard({ person, onClick }: PersonCardProps) {
  const t = useBrowsingI18n();
  const thumbnail = useQuery({
    queryKey: ["person-thumbnail", person.id],
    queryFn: () => getPersonThumbnail(person.id),
    staleTime: Infinity,
    retry: false,
  });
  return (
    <button
      type="button"
      className="card bg-base-100 p-3 text-left hover:bg-base-300 focus-visible:outline-primary"
      onClick={onClick}
    >
      <div className="aspect-square w-full overflow-hidden rounded-box bg-base-300">
        {thumbnail.data ? (
          <img src={thumbnail.data} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <UserRound size={48} className="text-base-content/40" />
          </div>
        )}
      </div>
      <p className="mt-3 truncate font-semibold">{person.name?.trim() || t("unnamed")}</p>
      <p className="text-sm text-base-content/60">
        {person.assetCount} {t("photos")}
      </p>
    </button>
  );
}
