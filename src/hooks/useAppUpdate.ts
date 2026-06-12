import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const LOG_PREFIX = "[updater]";

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "uptodate"
  | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  /** Version offered by the update, when one is available. */
  newVersion: string | null;
  /** Release notes for the available update, if provided. */
  notes: string | null;
  /** Download progress as a percentage (0-100), or null when unknown. */
  progress: number | null;
  /** Human-readable error message when status is "error". */
  error: string | null;
}

export interface UseAppUpdateResult extends AppUpdateState {
  /**
   * Check the configured endpoint for a newer version.
   * When `autoDownload` is true (default), an available update is downloaded
   * immediately and staged for install, leaving status at "ready".
   */
  checkForUpdate: (autoDownload?: boolean) => Promise<void>;
  /** Download and stage the currently available update without relaunching. */
  downloadUpdate: () => Promise<void>;
  /** Install the staged update and relaunch the app onto the new version. */
  installAndRelaunch: () => Promise<void>;
}

const INITIAL_STATE: AppUpdateState = {
  status: "idle",
  newVersion: null,
  notes: null,
  progress: null,
  error: null,
};

export function useAppUpdate(): UseAppUpdateResult {
  const [state, setState] = useState<AppUpdateState>(INITIAL_STATE);
  // Hold the resolved Update so a staged download can be installed later.
  const updateRef = useRef<Update | null>(null);
  // Guard against overlapping check/download operations.
  const inFlightRef = useRef(false);

  const toErrorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const downloadUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) {
      console.warn(`${LOG_PREFIX} downloadUpdate called with no staged update`);
      return;
    }

    let downloaded = 0;
    let contentLength = 0;
    console.log(`${LOG_PREFIX} download start version=${update.version}`);
    setState((prev) => ({
      ...prev,
      status: "downloading",
      progress: 0,
      error: null,
    }));

    try {
      await update.download((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength ?? 0;
            downloaded = 0;
            break;
          case "Progress": {
            downloaded += event.data.chunkLength;
            const progress =
              contentLength > 0
                ? Math.min(100, Math.round((downloaded / contentLength) * 100))
                : null;
            setState((prev) => ({ ...prev, progress }));
            break;
          }
          case "Finished":
            setState((prev) => ({ ...prev, progress: 100 }));
            break;
        }
      });
      console.log(`${LOG_PREFIX} download finished version=${update.version}`);
      setState((prev) => ({ ...prev, status: "ready", progress: 100 }));
    } catch (error) {
      console.error(`${LOG_PREFIX} download failed: ${toErrorMessage(error)}`);
      setState((prev) => ({
        ...prev,
        status: "error",
        error: toErrorMessage(error),
      }));
    }
  }, []);

  const checkForUpdate = useCallback(
    async (autoDownload = true) => {
      if (inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      console.log(`${LOG_PREFIX} check start`);
      setState((prev) => ({ ...prev, status: "checking", error: null }));

      try {
        const update = await check();
        if (!update) {
          console.log(`${LOG_PREFIX} check result=up-to-date`);
          updateRef.current = null;
          setState({ ...INITIAL_STATE, status: "uptodate" });
          return;
        }

        console.log(
          `${LOG_PREFIX} check result=available version=${update.version}`,
        );
        updateRef.current = update;
        setState({
          status: "available",
          newVersion: update.version,
          notes: update.body ?? null,
          progress: null,
          error: null,
        });

        if (autoDownload) {
          await downloadUpdate();
        }
      } catch (error) {
        console.error(`${LOG_PREFIX} check failed: ${toErrorMessage(error)}`);
        setState((prev) => ({
          ...prev,
          status: "error",
          error: toErrorMessage(error),
        }));
      } finally {
        inFlightRef.current = false;
      }
    },
    [downloadUpdate],
  );

  const installAndRelaunch = useCallback(async () => {
    const update = updateRef.current;
    if (!update) {
      console.warn(`${LOG_PREFIX} install called with no staged update`);
      return;
    }

    console.log(`${LOG_PREFIX} install start version=${update.version}`);
    try {
      await update.install();
      console.log(`${LOG_PREFIX} install complete, relaunching`);
      await relaunch();
    } catch (error) {
      console.error(`${LOG_PREFIX} install failed: ${toErrorMessage(error)}`);
      setState((prev) => ({
        ...prev,
        status: "error",
        error: toErrorMessage(error),
      }));
    }
  }, []);

  // Release the native update handle on unmount.
  useEffect(() => {
    return () => {
      void updateRef.current?.close();
    };
  }, []);

  return {
    ...state,
    checkForUpdate,
    downloadUpdate,
    installAndRelaunch,
  };
}
