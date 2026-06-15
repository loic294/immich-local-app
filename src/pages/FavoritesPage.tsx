import type { AppPage } from "../components/Layout/Sidebar";
import { PhotosPage } from "./PhotosPage";
import type { Session } from "../hooks/useSession";
import { useI18n } from "../i18n";

type FavoritesPageProps = {
  session: Session;
  onNavigate: (page: AppPage) => void;
  onLogout: () => void;
};

export function FavoritesPage({
  session,
  onNavigate,
  onLogout,
}: FavoritesPageProps) {
  const { t } = useI18n();

  return (
    <PhotosPage
      session={session}
      onNavigate={onNavigate}
      onLogout={onLogout}
      activePage="favorites"
      assetFilter="favorites"
      searchLabel={t("nav.favorites")}
    />
  );
}
