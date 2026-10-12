import { useI18n } from "./index";

const messages = {
  "en-CA": {
    search: "Search or name a new album",
    newAlbum: "New album",
    noResults: "No matching albums",
    undated: "Undated",
    offline: "Album changes require a connection. Cached albums remain available to browse.",
    failed: "Could not update the album. Please try again.",
    loadFailed: "Could not load cached albums.",
    choose: "Choose album",
    zoom: "Zoom",
    working: "Working…",
  },
  "fr-CA": {
    search: "Rechercher ou nommer un nouvel album",
    newAlbum: "Nouvel album",
    noResults: "Aucun album correspondant",
    undated: "Sans date",
    offline:
      "Les modifications d’albums nécessitent une connexion. Les albums en cache restent consultables.",
    failed: "Impossible de modifier l’album. Veuillez réessayer.",
    loadFailed: "Impossible de charger les albums en cache.",
    choose: "Choisir un album",
    zoom: "Zoom",
    working: "En cours…",
  },
};

export function useAlbumPickerLabels() {
  const { locale } = useI18n();
  return messages[locale];
}
