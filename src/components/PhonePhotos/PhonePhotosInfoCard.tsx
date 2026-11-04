import { Info } from "lucide-react";

interface PhonePhotosInfoCardProps {
  title: string;
  description: string;
}

export function PhonePhotosInfoCard({ title, description }: PhonePhotosInfoCardProps) {
  return (
    <aside
      data-test="phone-photos-info-card"
      aria-label={title}
      className="card card-border shrink-0 bg-base-100 shadow-sm"
    >
      <div className="card-body flex-row items-start gap-3 p-4">
        <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-info" />
        <div className="min-w-0">
          <h2 className="card-title text-base">{title}</h2>
          <p className="text-sm text-base-content/70">{description}</p>
        </div>
      </div>
    </aside>
  );
}
