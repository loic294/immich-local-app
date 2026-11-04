import { useEffect, useId, useState } from "react";
import { updateSettings } from "../../api/tauri";
import { useFolderPaths } from "../../hooks/useFolderPaths";
import { usePhonePhotosDefaults, usePhonePhotosI18n } from "../../i18n/phonePhotos";
import type { Settings } from "../../types";

interface PhonePhotosSettingsProps {
  settings: Settings;
  onSaved: (settings: Settings) => void;
}

export function PhonePhotosSettings({ settings, onSaved }: PhonePhotosSettingsProps) {
  const t = usePhonePhotosI18n();
  const defaults = usePhonePhotosDefaults();
  const folderPaths = useFolderPaths(true);
  const listId = useId();

  const storedTitle = settings.phonePhotosInfoTitle.trim() || defaults.title;
  const storedDescription = settings.phonePhotosInfoDescription.trim() || defaults.description;

  const [folderPath, setFolderPath] = useState(settings.phonePhotosFolderPath);
  const [infoVisible, setInfoVisible] = useState(settings.phonePhotosInfoVisible);
  const [infoTitle, setInfoTitle] = useState(storedTitle);
  const [infoDescription, setInfoDescription] = useState(storedDescription);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "saved" | "error"; message: string } | null>(null);

  // Re-sync drafts when the persisted values change (e.g. after saving or a locale switch).
  useEffect(() => {
    setFolderPath(settings.phonePhotosFolderPath);
    setInfoVisible(settings.phonePhotosInfoVisible);
    setInfoTitle(storedTitle);
    setInfoDescription(storedDescription);
  }, [
    settings.phonePhotosFolderPath,
    settings.phonePhotosInfoVisible,
    storedTitle,
    storedDescription,
  ]);

  const markDirty = () => setStatus(null);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    // Text equal to the localized default is stored empty so a language change still applies.
    const titleToStore = infoTitle.trim() === defaults.title ? "" : infoTitle.trim();
    const descriptionToStore =
      infoDescription.trim() === defaults.description ? "" : infoDescription.trim();
    console.info("[phone_photos:settings] saving", {
      hasFolderPath: folderPath.trim().length > 0,
      infoVisible,
      customTitle: titleToStore.length > 0,
      customDescription: descriptionToStore.length > 0,
    });
    try {
      const updated = await updateSettings({
        ...settings,
        phonePhotosFolderPath: folderPath,
        phonePhotosInfoVisible: infoVisible,
        phonePhotosInfoTitle: titleToStore,
        phonePhotosInfoDescription: descriptionToStore,
      });
      onSaved(updated);
      setStatus({ kind: "saved", message: t("saved") });
      console.info("[phone_photos:settings] saved", {
        folderPath: updated.phonePhotosFolderPath,
      });
    } catch (error) {
      console.error("[phone_photos:settings] save failed", error);
      setStatus({ kind: "error", message: t("saveFailed", { message: String(error) }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body gap-4">
        <div>
          <h2 className="card-title">{t("settingsTitle")}</h2>
          <p className="text-sm text-base-content/70">{t("settingsDescription")}</p>
        </div>

        <label className="fieldset">
          <span className="fieldset-legend">{t("folderPathLabel")}</span>
          <input
            className="input w-full"
            type="text"
            list={listId}
            value={folderPath}
            placeholder={t("folderPathPlaceholder")}
            disabled={saving}
            onChange={(event) => {
              setFolderPath(event.currentTarget.value);
              markDirty();
            }}
          />
          <datalist id={listId}>
            {(folderPaths.data ?? []).map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
          <span className="label whitespace-normal">{t("folderPathHelp")}</span>
        </label>

        <label className="label cursor-pointer justify-between gap-4 whitespace-normal">
          <span>
            <span className="block font-medium">{t("infoVisibleLabel")}</span>
            <span className="block text-sm text-base-content/70">{t("infoVisibleHelp")}</span>
          </span>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={infoVisible}
            disabled={saving}
            onChange={(event) => {
              setInfoVisible(event.currentTarget.checked);
              markDirty();
            }}
          />
        </label>

        <label className="fieldset">
          <span className="fieldset-legend">{t("infoTitleLabel")}</span>
          <input
            className="input w-full"
            type="text"
            value={infoTitle}
            disabled={saving}
            onChange={(event) => {
              setInfoTitle(event.currentTarget.value);
              markDirty();
            }}
          />
        </label>

        <label className="fieldset">
          <span className="fieldset-legend">{t("infoDescriptionLabel")}</span>
          <textarea
            className="textarea min-h-24 w-full"
            value={infoDescription}
            disabled={saving}
            onChange={(event) => {
              setInfoDescription(event.currentTarget.value);
              markDirty();
            }}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? t("saving") : t("save")}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving}
            onClick={() => {
              setInfoTitle(defaults.title);
              setInfoDescription(defaults.description);
              markDirty();
            }}
          >
            {t("resetToDefault")}
          </button>
        </div>

        {status && (
          <p
            role={status.kind === "error" ? "alert" : "status"}
            className={`text-sm ${status.kind === "error" ? "text-error" : "text-success"}`}
          >
            {status.message}
          </p>
        )}
      </div>
    </div>
  );
}
