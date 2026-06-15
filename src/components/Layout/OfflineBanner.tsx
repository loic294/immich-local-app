import { useI18n } from "../../i18n";

type OfflineBannerProps = {
  /** Number of local changes queued for replay once back online. */
  pendingCount: number;
};

/**
 * Persistent, solid (non-translucent) indicator shown while the app runs in
 * offline mode. Rendered inline (e.g. in the sidebar, above the sync card) so it
 * sits within the layout instead of floating over content. Communicates that
 * content is served from the local cache and surfaces how many local edits are
 * waiting to sync.
 */
export function OfflineBanner({ pendingCount }: OfflineBannerProps) {
  const { t } = useI18n();

  return (
    <div
      role="status"
      aria-live="polite"
      className="alert alert-warning flex w-full flex-wrap items-center gap-2 rounded-box"
    >
      <span
        className="inline-block size-2 shrink-0 rounded-full bg-warning-content/70"
        aria-hidden="true"
      />
      <span className="text-sm font-medium">{t("offline.title")}</span>
      {pendingCount > 0 && (
        <span className="badge badge-sm badge-neutral">
          {pendingCount === 1
            ? t("offline.pendingSingular", { count: pendingCount })
            : t("offline.pendingPlural", { count: pendingCount })}
        </span>
      )}
    </div>
  );
}
