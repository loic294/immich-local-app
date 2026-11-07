import { useI18n } from "./index";

const messages = {
  "en-CA": {
    title: "Manage access",
    close: "Close",
    cancel: "Cancel",
    owner: "Owner",
    peopleHeading: "People with access",
    noPeople: "This album isn’t shared with anyone yet.",
    permission: "Permission",
    editor: "Editor",
    viewer: "Viewer",
    roleHelp: "Editors can add photos to the album. Viewers can only look at it.",
    remove: "Remove",
    removeConfirm: "Remove access?",
    addHeading: "Add a person",
    selectPerson: "Select a person",
    add: "Add",
    adding: "Adding…",
    noCandidates: "There’s no one else on this server to add.",
    loading: "Loading…",
    loadFailed: "Could not load the people who have access. Check your connection and try again.",
    retry: "Try again",
    updateFailed:
      "Could not change this permission. Only the album owner can do that, and your API key must allow updating album users (albumUser.update).",
    addFailed:
      "Could not add this person. Only the album owner can do that, and your API key must allow adding album users (albumUser.create).",
    removeFailed:
      "Could not remove this person. Only the album owner can do that, and your API key must allow removing album users (albumUser.delete).",
    offline: "Managing access requires a connection to your server.",
  },
  "fr-CA": {
    title: "Gérer l’accès",
    close: "Fermer",
    cancel: "Annuler",
    owner: "Propriétaire",
    peopleHeading: "Personnes ayant accès",
    noPeople: "Cet album n’est encore partagé avec personne.",
    permission: "Autorisation",
    editor: "Éditeur",
    viewer: "Lecteur",
    roleHelp:
      "Les éditeurs peuvent ajouter des photos à l’album. Les lecteurs peuvent seulement le consulter.",
    remove: "Retirer",
    removeConfirm: "Retirer l’accès ?",
    addHeading: "Ajouter une personne",
    selectPerson: "Choisir une personne",
    add: "Ajouter",
    adding: "Ajout…",
    noCandidates: "Il n’y a personne d’autre à ajouter sur ce serveur.",
    loading: "Chargement…",
    loadFailed:
      "Impossible de charger les personnes ayant accès. Vérifiez votre connexion et réessayez.",
    retry: "Réessayer",
    updateFailed:
      "Impossible de modifier cette autorisation. Seul le propriétaire de l’album peut le faire et votre clé d’API doit autoriser la modification des utilisateurs d’album (albumUser.update).",
    addFailed:
      "Impossible d’ajouter cette personne. Seul le propriétaire de l’album peut le faire et votre clé d’API doit autoriser l’ajout d’utilisateurs d’album (albumUser.create).",
    removeFailed:
      "Impossible de retirer cette personne. Seul le propriétaire de l’album peut le faire et votre clé d’API doit autoriser le retrait d’utilisateurs d’album (albumUser.delete).",
    offline: "Gérer l’accès nécessite une connexion à votre serveur.",
  },
};

export function useAlbumAccessLabels() {
  const { locale } = useI18n();
  return messages[locale];
}
