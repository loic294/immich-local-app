import { useEffect, useRef } from "react";
import { logActivity } from "../utils/activityLogSink";

/** Records a `ui` Activity Log entry whenever the active top-level view changes. */
export function useActivityNavigationLog(view: string): void {
  // A ref (not an effect-only dependency) keeps StrictMode's double effect run from logging twice.
  const lastLogged = useRef<string | null>(null);
  useEffect(() => {
    if (lastLogged.current === view) return;
    lastLogged.current = view;
    logActivity("info", "ui", `navigated to ${view}`);
  }, [view]);
}
