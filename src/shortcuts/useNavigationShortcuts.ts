import { useEffect, useLayoutEffect, useRef } from "react";
import type { AppPage } from "../components/Layout/Sidebar";
import type { ShortcutActionId } from "./catalog";
import { shortcutRegistry } from "./shortcutRegistry";

const NAVIGATION_SHORTCUTS: readonly (readonly [ShortcutActionId, AppPage])[] = [
  ["nav.photos", "photos"],
  ["nav.albums", "albums"],
  ["nav.favorites", "favorites"],
  ["nav.people", "people"],
  ["nav.maps", "maps"],
  ["nav.calendar", "calendar"],
  ["nav.folders", "folders"],
  ["nav.phonePhotos", "phonePhotos"],
  ["nav.deleted", "deleted"],
  ["nav.settings", "settings"],
];

/**
 * Registers the page-switching shortcuts. They work in every view, even for pages hidden from the
 * sidebar, so the native menu's "View albums" never depends on sidebar preferences.
 */
export function useNavigationShortcuts(onNavigate: (page: AppPage) => void): void {
  const onNavigateRef = useRef(onNavigate);

  useLayoutEffect(() => {
    onNavigateRef.current = onNavigate;
  });

  useEffect(() => {
    const unregister = NAVIGATION_SHORTCUTS.map(([actionId, page]) =>
      shortcutRegistry.register(
        actionId,
        () => {
          console.info("[shortcuts] navigating", { actionId, page });
          if (page === "albums") {
            // Leaves an opened album and shows the albums list, like the sidebar's active item.
            window.dispatchEvent(new CustomEvent("immich:show-albums"));
          }
          onNavigateRef.current(page);
        },
        "global",
      ),
    );
    return () => unregister.forEach((stop) => stop());
  }, []);
}
