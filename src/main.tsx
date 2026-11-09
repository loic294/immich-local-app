import React, { type ComponentType } from "react";
import ReactDOM from "react-dom/client";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { setupActivityCapture } from "./utils/activityCapture";
import { logMutationFailure, logQueryFailure } from "./utils/activityQueryLog";
import { setupFileLogging } from "./utils/logger";
import { isActivityLogWindow } from "./windows/windowLabel";
import "./styles.css";

// Persist frontend console logs to files in the Cache Location (production only).
setupFileLogging();
// Feed the Activity Log; wraps the console on top of the file logger installed above.
setupActivityCapture();

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: logQueryFailure }),
  mutationCache: new MutationCache({ onError: logMutationFailure }),
});

type WindowRoot = ComponentType<{ queryClient: QueryClient }>;

// Each window loads only its own UI, so the Activity Log window never evaluates the app's
// sync, polling and native-menu code.
function loadWindowRoot(): Promise<WindowRoot> {
  if (isActivityLogWindow()) {
    return import("./windows/ActivityLogWindowRoot").then((module) => module.ActivityLogWindowRoot);
  }
  return import("./windows/MainWindowRoot").then((module) => module.MainWindowRoot);
}

loadWindowRoot()
  .then((Root) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <Root queryClient={queryClient} />
      </React.StrictMode>,
    );
  })
  .catch((error) => {
    console.error("[window] failed to load the window UI", error);
  });
