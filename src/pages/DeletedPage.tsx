import type { AppPage } from "../components/Layout/Sidebar";
import { PhotosPage } from "./PhotosPage";
import type { Session } from "../hooks/useSession";
import { useI18n } from "../i18n";
import { useSettings } from "../hooks/useSettings";

type DeletedPageProps = {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
};

export function DeletedPage({ session, onNavigate, onLogout }: DeletedPageProps) {
  const { t } = useI18n();
  const { data: settings, error } = useSettings();
  if (!settings) {
    return (
      <div role="status" className="p-4">
        {error ? String(error) : <span className="loading loading-spinner" />}
      </div>
    );
  }

  return (
    <PhotosPage
      session={session}
      onNavigate={onNavigate}
      onLogout={onLogout}
      activePage="deleted"
      assetFilter={settings?.deleteBehavior === "trash" ? "trashed" : "archived"}
      searchLabel={t("nav.deleted")}
    />
  );
}
