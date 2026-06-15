import type { AppPage } from "../components/Layout/Sidebar";
import { PhotosPage } from "./PhotosPage";
import type { Session } from "../hooks/useSession";
import { useI18n } from "../i18n";

type DeletedPageProps = {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
};

export function DeletedPage({
  session,
  onNavigate,
  onLogout,
}: DeletedPageProps) {
  const { t } = useI18n();

  return (
    <PhotosPage
      session={session}
      onNavigate={onNavigate}
      onLogout={onLogout}
      activePage="deleted"
      assetFilter="archived"
      searchLabel={t("nav.deleted")}
    />
  );
}
