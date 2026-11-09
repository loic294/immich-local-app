import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { ActivityLogWindow } from "../components/ActivityLog/ActivityLogWindow";
import { I18nProvider } from "../i18n";

interface ActivityLogWindowRootProps {
  queryClient: QueryClient;
}

/**
 * The Activity Log window. It deliberately mounts neither `App` nor `ShortcutProvider`: the app's
 * sync, polling and native-menu handling must run once, in the main window only.
 */
export function ActivityLogWindowRoot({ queryClient }: ActivityLogWindowRootProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ActivityLogWindow />
      </I18nProvider>
    </QueryClientProvider>
  );
}
