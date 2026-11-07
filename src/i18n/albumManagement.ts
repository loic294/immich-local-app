import { useI18n } from "./index";

const messages = {
  "en-CA": {
    actionsAria: "Album actions",
    offlineHint: "Connect to your server to rename or delete this album.",
    rename: "Rename album",
    renameTitle: "Rename album",
    renameField: "Album name",
    renameEmpty: "Enter an album name.",
    renameSave: "Save",
    renaming: "Saving…",
    renameFailed:
      "Could not rename the album. Only the album owner can rename it, and your API key must allow album updates (album.update).",
    delete: "Delete album",
    deleteTitle: "Delete album",
    deleteConfirm:
      "The album is removed from your server. Photos stay in your library, and copies saved on this computer are kept. This can’t be undone.",
    deleteSharedWarning: "This album is shared, so other people will lose access to it.",
    deleting: "Deleting…",
    deleteFailed:
      "Could not delete the album. Only the album owner can delete it, and your API key must allow album deletion (album.delete).",
    offline: "Renaming or deleting an album requires a connection to your server.",
    createTitle: "Create new album",
    createField: "Album name",
    createSave: "Create",
    creating: "Creating…",
    createFailed:
      "Could not create the album. Check that your API key allows album creation (album.create).",
    createOffline: "Creating an album requires a connection to your server.",
  },
  "fr-CA": {
    actionsAria: "Actions de l’album",
    offlineHint: "Connectez-vous à votre serveur pour renommer ou supprimer cet album.",
    rename: "Renommer l’album",
    renameTitle: "Renommer l’album",
    renameField: "Nom de l’album",
    renameEmpty: "Saisissez un nom d’album.",
    renameSave: "Enregistrer",
    renaming: "Enregistrement…",
    renameFailed:
      "Impossible de renommer l’album. Seul le propriétaire peut le renommer et votre clé d’API doit autoriser la modification des albums (album.update).",
    delete: "Supprimer l’album",
    deleteTitle: "Supprimer l’album",
    deleteConfirm:
      "L’album est retiré de votre serveur. Les photos restent dans votre bibliothèque et les copies enregistrées sur cet ordinateur sont conservées. Cette action est irréversible.",
    deleteSharedWarning: "Cet album est partagé : les autres personnes perdront l’accès.",
    deleting: "Suppression…",
    deleteFailed:
      "Impossible de supprimer l’album. Seul le propriétaire peut le supprimer et votre clé d’API doit autoriser la suppression des albums (album.delete).",
    offline: "Renommer ou supprimer un album nécessite une connexion à votre serveur.",
    createTitle: "Créer un nouvel album",
    createField: "Nom de l’album",
    createSave: "Créer",
    creating: "Création…",
    createFailed:
      "Impossible de créer l’album. Vérifiez que votre clé d’API autorise la création d’albums (album.create).",
    createOffline: "Créer un album nécessite une connexion à votre serveur.",
  },
};

export function useAlbumManagementLabels() {
  const { locale } = useI18n();
  return messages[locale];
}
