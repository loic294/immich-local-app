import { TriangleAlert } from "lucide-react";
import { useActivityLogLabels } from "../../i18n/activityLog";
import type { ActivityLogError } from "../../types/activityLog";

interface ActivityLogErrorBannerProps {
  error: ActivityLogError;
}

export function ActivityLogErrorBanner({ error }: ActivityLogErrorBannerProps) {
  const labels = useActivityLogLabels();

  return (
    <div
      role="alert"
      className="alert alert-warning alert-soft shrink-0 rounded-none px-3 py-2 text-sm"
    >
      <TriangleAlert size={16} aria-hidden="true" />
      <span className="min-w-0 break-words">{labels.errors[error.kind](error.message)}</span>
    </div>
  );
}
