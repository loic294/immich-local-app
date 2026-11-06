import { useI18n } from "./index";

const messages = {
  "en-CA": {
    title: "New album ownership",
    description:
      "Choose the account where new albums are created. These defaults apply to new albums only, on macOS and Windows.",
    owner: "Primary album owner",
    missingOwner: "Choose an available account",
    editors: "Additional collaborators (editors)",
    editorHelp:
      "Immich has one owner per album. Editors can contribute photos, including users who are not signed in to this app. All collaborators must be on the owner's server.",
    contributionHelp:
      "Select every signed-in account whose photos you want to add. All editors are added before any photos; each signed-in account then contributes its own photos. To add another user's private photos, sign in to that account first.",
    loading: "Loading server users...",
    loadFailed: "Could not load server users. Saved selections and local accounts are still shown.",
    retry: "Retry",
    empty: "No other users available.",
    save: "Save",
    saving: "Saving...",
    saved: "Album ownership settings saved.",
    saveFailed: "Could not save album ownership settings.",
  },
  "fr-CA": {
    title: "Propriété des nouveaux albums",
    description:
      "Choisissez le compte dans lequel les nouveaux albums sont créés. Ces réglages s'appliquent uniquement aux nouveaux albums, sur macOS et Windows.",
    owner: "Propriétaire principal de l'album",
    missingOwner: "Choisir un compte disponible",
    editors: "Collaborateurs supplémentaires (éditeurs)",
    editorHelp:
      "Un album Immich a un seul propriétaire. Les éditeurs peuvent ajouter des photos, même s'ils ne sont pas connectés à cette application. Tous doivent être sur le serveur du propriétaire.",
    contributionHelp:
      "Sélectionnez chaque compte connecté dont vous voulez ajouter les photos. Tous les éditeurs sont ajoutés avant les photos, puis chaque compte connecté ajoute ses propres photos. Pour ajouter les photos privées d'un autre utilisateur, connectez d'abord son compte.",
    loading: "Chargement des utilisateurs du serveur...",
    loadFailed:
      "Impossible de charger les utilisateurs du serveur. Les sélections enregistrées et les comptes locaux restent affichés.",
    retry: "Réessayer",
    empty: "Aucun autre utilisateur disponible.",
    save: "Enregistrer",
    saving: "Enregistrement...",
    saved: "Réglages de propriété des albums enregistrés.",
    saveFailed: "Impossible d'enregistrer les réglages de propriété des albums.",
  },
};

export function useAlbumCreationLabels() {
  const { locale } = useI18n();
  return messages[locale];
}
