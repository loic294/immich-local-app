import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { getPersonThumbnail } from "../../api/tauri";
import type { BrowsingPerson } from "../../types/browsing";

interface PersonThumbnailProps {
  person: BrowsingPerson;
}

export function PersonThumbnail({ person }: PersonThumbnailProps) {
  const thumbnail = useQuery({
    queryKey: ["person-thumbnail", person.accountId, person.id],
    queryFn: () => getPersonThumbnail(person.id, person.accountId),
    staleTime: Infinity,
    retry: false,
  });
  return thumbnail.data ? (
    <img src={thumbnail.data} alt="" className="h-full w-full object-cover" />
  ) : (
    <div className="flex h-full items-center justify-center">
      <UserRound size={32} className="text-base-content/40" />
    </div>
  );
}
