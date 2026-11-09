import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { App } from "../App";
import { I18nProvider } from "../i18n";
import { ShortcutProvider } from "../shortcuts/ShortcutProvider";

interface MainWindowRootProps {
  queryClient: QueryClient;
}

/** The photo library window. Only this window handles native menu actions and shortcuts. */
export function MainWindowRoot({ queryClient }: MainWindowRootProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ShortcutProvider>
          <App />
        </ShortcutProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
