import type { AppPage } from "../components/Layout/Sidebar";
import { PhotosPage } from "./PhotosPage";
import type { Session } from "../hooks/useSession";

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
  return (
    <PhotosPage
      session={session}
      onNavigate={onNavigate}
      onLogout={onLogout}
      activePage="deleted"
      assetFilter="archived"
      searchLabel="Deleted"
    />
  );
}
