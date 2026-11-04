import { useI18n } from "./index";

const messages = {
  "en-CA": {
    title: "Phone Photos",
    defaultInfoTitle: "Missing photos? How to sync them",
    defaultInfoDescription:
      "On your phone, open Synology Photos (the orange flower). Leave the app opened and the photos should appear here soon.",
    searchPlaceholder: "Search phone photos",
    loading: "Loading phone photos…",
    notConfigured: "No phone photos folder is set",
    notConfiguredHelp:
      "Choose the Immich library folder that receives your phone photos in Settings.",
    openSettings: "Open settings",
    emptyFolder: "No photos found in this folder yet",
    emptyFolderHelp: "New photos will appear here after your phone finishes syncing.",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    refreshFailed: "Could not refresh phone photos from the server: {message}",
    loadFailed: "Could not load phone photos: {message}",
    settingsTitle: "Phone Photos",
    settingsDescription:
      "Choose which Immich library folder is shown on the Phone Photos page and customize its info card.",
    folderPathLabel: "Phone photos folder",
    folderPathPlaceholder: "/mnt/synology/PhoneBackup",
    folderPathHelp:
      "An Immich library folder path, as shown on the Folders page. Only photos directly inside this folder are shown, not those in its subfolders.",
    infoVisibleLabel: "Show the info card",
    infoVisibleHelp: "Display the sync help card at the top of the Phone Photos page.",
    infoTitleLabel: "Info card title",
    infoDescriptionLabel: "Info card description",
    resetToDefault: "Reset to default text",
    save: "Save",
    saving: "Saving…",
    saved: "Phone Photos settings saved.",
    saveFailed: "Could not save Phone Photos settings: {message}",
  },
  "fr-CA": {
    title: "Photos du téléphone",
    defaultInfoTitle: "Photos manquantes ? Comment les synchroniser",
    defaultInfoDescription:
      "Sur votre téléphone, ouvrez Synology Photos (la fleur orange). Laissez l’application ouverte et les photos devraient bientôt apparaître ici.",
    searchPlaceholder: "Rechercher dans les photos du téléphone",
    loading: "Chargement des photos du téléphone…",
    notConfigured: "Aucun dossier de photos du téléphone n’est défini",
    notConfiguredHelp:
      "Choisissez dans les paramètres le dossier de la bibliothèque Immich qui reçoit les photos de votre téléphone.",
    openSettings: "Ouvrir les paramètres",
    emptyFolder: "Aucune photo dans ce dossier pour le moment",
    emptyFolderHelp:
      "Les nouvelles photos apparaîtront ici une fois la synchronisation de votre téléphone terminée.",
    refresh: "Actualiser",
    refreshing: "Actualisation…",
    refreshFailed: "Impossible d’actualiser les photos du téléphone depuis le serveur : {message}",
    loadFailed: "Impossible de charger les photos du téléphone : {message}",
    settingsTitle: "Photos du téléphone",
    settingsDescription:
      "Choisissez le dossier de la bibliothèque Immich affiché sur la page Photos du téléphone et personnalisez sa carte d’information.",
    folderPathLabel: "Dossier des photos du téléphone",
    folderPathPlaceholder: "/mnt/synology/PhoneBackup",
    folderPathHelp:
      "Un chemin de dossier de la bibliothèque Immich, tel qu’affiché sur la page Dossiers. Seules les photos situées directement dans ce dossier sont affichées, pas celles de ses sous-dossiers.",
    infoVisibleLabel: "Afficher la carte d’information",
    infoVisibleHelp:
      "Affiche la carte d’aide à la synchronisation en haut de la page Photos du téléphone.",
    infoTitleLabel: "Titre de la carte d’information",
    infoDescriptionLabel: "Description de la carte d’information",
    resetToDefault: "Rétablir le texte par défaut",
    save: "Enregistrer",
    saving: "Enregistrement…",
    saved: "Paramètres des photos du téléphone enregistrés.",
    saveFailed: "Impossible d’enregistrer les paramètres des photos du téléphone : {message}",
  },
};

export type PhonePhotosMessageKey = keyof (typeof messages)["en-CA"];

export type PhonePhotosTranslator = (
  key: PhonePhotosMessageKey,
  params?: Record<string, string>,
) => string;

export function usePhonePhotosI18n(): PhonePhotosTranslator {
  const { locale } = useI18n();
  return (key, params) => {
    let text: string = messages[locale][key];
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.split(`{${name}}`).join(value);
    }
    return text;
  };
}

/** Localized default info-card text, used when no custom text is stored. */
export function usePhonePhotosDefaults() {
  const { locale } = useI18n();
  return {
    title: messages[locale].defaultInfoTitle,
    description: messages[locale].defaultInfoDescription,
  };
}
