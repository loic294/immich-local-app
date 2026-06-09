import type { Session } from "../../hooks/useSession";
import { Header } from "./Header";

interface AppTopBarProps {
  session: Session;
  onLogout: () => void;
  searchInput: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
}

export function AppTopBar({
  session,
  onLogout,
  searchInput,
  onSearchChange,
  searchPlaceholder,
}: AppTopBarProps) {
  return (
    <Header
      searchInput={searchInput}
      onSearchChange={onSearchChange}
      serverUrl={session.serverUrl}
      userId={session.userId}
      userName={session.userName}
      onLogout={onLogout}
      searchPlaceholder={searchPlaceholder}
    />
  );
}
