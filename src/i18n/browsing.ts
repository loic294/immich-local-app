import { useI18n } from "./index";

const messages = {
  "en-CA": {
    people: "People",
    maps: "Map",
    unnamed: "Unnamed person",
    peopleEmpty: "No people in the local cache yet. Run a sync to populate people.",
    searchPeople: "Search people",
    sortPeople: "Sort people",
    sortName: "Name",
    sortPhotoCount: "Number of photos",
    backPeople: "Back to people",
    photos: "photos",
    mapEmpty: "No cached photos with GPS coordinates.",
    mapOffline: "Base map unavailable offline. Cached photo locations and photos remain available.",
    mapError: "The base map could not load. Cached photo locations and photos remain available.",
    viewport: "Photos in this area",
    selected: "Selected location",
    allLocations: "Show all locations",
    loading: "Loading cached photos…",
    refresh: "Refresh this area",
    path: "Toggle file path",
    openMap: "Open in map",
    location: "Location",
    retry: "Retry",
  },
  "fr-CA": {
    people: "Personnes",
    maps: "Carte",
    unnamed: "Personne sans nom",
    peopleEmpty: "Aucune personne en cache. Lancez une synchronisation pour ajouter les personnes.",
    searchPeople: "Rechercher des personnes",
    sortPeople: "Trier les personnes",
    sortName: "Nom",
    sortPhotoCount: "Nombre de photos",
    backPeople: "Retour aux personnes",
    photos: "photos",
    mapEmpty: "Aucune photo en cache avec des coordonnées GPS.",
    mapOffline:
      "Fond de carte indisponible hors ligne. Les positions et photos en cache restent disponibles.",
    mapError:
      "Le fond de carte n’a pas pu être chargé. Les positions et photos en cache restent disponibles.",
    viewport: "Photos dans cette zone",
    selected: "Lieu sélectionné",
    allLocations: "Afficher tous les lieux",
    loading: "Chargement des photos en cache…",
    refresh: "Actualiser cette zone",
    path: "Afficher le chemin du fichier",
    openMap: "Ouvrir sur la carte",
    location: "Lieu",
    retry: "Réessayer",
  },
};

export function useBrowsingI18n() {
  const { locale } = useI18n();
  return (key: keyof (typeof messages)["en-CA"]) => messages[locale][key];
}
