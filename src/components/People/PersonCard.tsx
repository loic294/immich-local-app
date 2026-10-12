import { PersonThumbnail } from "./PersonThumbnail";
import { useBrowsingI18n } from "../../i18n/browsing";
import type { BrowsingPerson } from "../../types/browsing";

interface PersonCardProps {
  person: BrowsingPerson;
  onClick: () => void;
  onAssign: () => void;
}

export function PersonCard({ person, onClick, onAssign }: PersonCardProps) {
  const t = useBrowsingI18n();
  return (
    <div className="card bg-base-100 p-3">
      <button
        type="button"
        className="w-full text-left focus-visible:outline-primary"
        onClick={onClick}
        aria-label={person.name?.trim() || t("unnamed")}
      >
        <div className="aspect-square w-full overflow-hidden rounded-box bg-base-300">
          <PersonThumbnail person={person} />
        </div>
      </button>
      <button
        type="button"
        className="mt-3 truncate text-left font-semibold hover:underline focus-visible:outline-primary"
        onClick={person.name?.trim() ? onClick : onAssign}
      >
        {person.name?.trim() || t("unnamed")}
      </button>
      <p className="text-sm text-base-content/60">
        {person.assetCount} {t("photos")}
      </p>
    </div>
  );
}
