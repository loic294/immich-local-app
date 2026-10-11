import { useEffect, useState } from "react";
import {
  getMediaPreferences,
  updateMediaPreferences,
  type MediaPreferences,
} from "../../api/media";
import { useMediaLabels } from "../../i18n/media";

interface MediaSettingsProps {
  section?: "editing" | "privacy";
}
export function MediaSettings({ section = "editing" }: MediaSettingsProps) {
  const labels = useMediaLabels();
  const [preferences, setPreferences] = useState<MediaPreferences | null>(null);
  const [args, setArgs] = useState("");
  const [sidecars, setSidecars] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void getMediaPreferences()
      .then((value) => {
        if (!active) return;
        setPreferences(value);
        setArgs(JSON.stringify(value.editorExportArgs, null, 2));
        setSidecars(value.editorSidecars.join(", "));
      })
      .catch((error) => {
        console.error("[media:settings] load failed", error);
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, []);
  const save = async () => {
    if (!preferences) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const parsed: unknown = JSON.parse(args);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((arg): arg is string => typeof arg === "string")
      ) {
        throw new Error(labels.invalidArgs);
      }
      const value = await updateMediaPreferences({
        ...preferences,
        editorExportArgs: parsed,
        editorSidecars: sidecars
          .split(",")
          .map((s) => s.trim().replace(/^\./, ""))
          .filter(Boolean),
      });
      setPreferences(value);
      setSaved(true);
    } catch (error) {
      console.error("[media:settings] save failed", error);
      setError(String(error));
      // A failed final analytics event must not accidentally re-enable tracking.
      setPreferences(
        await getMediaPreferences().catch((reloadError) => {
          console.error("[media:settings] reload failed", reloadError);
          return preferences;
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card bg-base-200">
      <div className="card-body">
        <h2 className="card-title">{section === "privacy" ? labels.privacy : labels.editing}</h2>
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        {preferences &&
          (section === "editing" ? (
            <>
              <label className="fieldset">
                <span>{labels.executable}</span>
                <input
                  className="input w-full"
                  value={preferences.editorExecutable}
                  onChange={(event) =>
                    setPreferences({ ...preferences, editorExecutable: event.target.value })
                  }
                />
              </label>
              <label className="fieldset">
                <span>{labels.arguments}</span>
                <textarea
                  className="textarea w-full font-mono"
                  rows={7}
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                />
                <span className="text-sm text-base-content/65">{labels.argumentHelp}</span>
              </label>
              <label className="fieldset">
                <span>{labels.sidecars}</span>
                <input
                  className="input w-full"
                  value={sidecars}
                  onChange={(event) => setSidecars(event.target.value)}
                />
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  className="toggle toggle-primary"
                  checked={preferences.importRequiresAlbum}
                  onChange={(event) =>
                    setPreferences({ ...preferences, importRequiresAlbum: event.target.checked })
                  }
                />
                {labels.requireAlbum}
              </label>
            </>
          ) : (
            <>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  className="toggle toggle-primary"
                  checked={preferences.telemetryEnabled}
                  onChange={(event) =>
                    setPreferences({ ...preferences, telemetryEnabled: event.target.checked })
                  }
                />
                {labels.telemetry}
              </label>
              <p className="text-sm text-base-content/65">{labels.telemetryHelp}</p>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  className="toggle toggle-primary"
                  checked={preferences.sessionReplayEnabled ?? false}
                  onChange={(event) =>
                    setPreferences({ ...preferences, sessionReplayEnabled: event.target.checked })
                  }
                />
                {labels.replay}
              </label>
              <p className="text-sm text-base-content/65">{labels.replayHelp}</p>
            </>
          ))}
        <div className="card-actions justify-end">
          {saved && (
            <span role="status" className="text-success">
              {labels.saved}
            </span>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !preferences}
            onClick={() => void save()}
          >
            {busy ? labels.busy : labels.save}
          </button>
        </div>
      </div>
    </section>
  );
}
