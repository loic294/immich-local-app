import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { ShortcutProvider } from "./shortcuts/ShortcutProvider";
import { setupFileLogging } from "./utils/logger";
import "./styles.css";

// Persist frontend console logs to files in the Cache Location (production only).
setupFileLogging();

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ShortcutProvider>
          <App />
        </ShortcutProvider>
      </I18nProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
