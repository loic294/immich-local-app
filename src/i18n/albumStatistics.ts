import { useI18n } from "./index";

type Plural = (count: number, formatted: string) => string;

const english =
  (singular: string, plural: string): Plural =>
  (count, formatted) =>
    `${formatted} ${count === 1 ? singular : plural}`;

// French uses the singular for 0 and 1.
const french =
  (singular: string, plural: string): Plural =>
  (count, formatted) =>
    `${formatted} ${count < 2 ? singular : plural}`;

const messages = {
  "en-CA": {
    title: "Album statistics",
    description:
      "Calculated from the local cache, so it also works offline. Each photo or video is counted once, even when it belongs to several albums.",
    refresh: "Refresh statistics",
    loading: "Calculating album statistics…",
    loadFailed: "Could not calculate album statistics.",
    retry: "Retry",
    empty: "No albums or photos are cached yet. Sync your library to see statistics.",
    albums: "Albums",
    inAlbums: "In an album",
    notInAlbums: "Not in an album",
    ofLibrary: (percent: string) => `${percent} of library`,
    shared: english("shared", "shared"),
    albumCount: english("album", "albums"),
    photoCount: english("photo", "photos"),
    unsynced: (count: number, formatted: string) =>
      `${english("album has", "albums have")(count, formatted)} not loaded their photos yet, so “In an album” may be undercounted. Open those albums or run Force Full Sync to include them.`,
    coverageTitle: "Library coverage",
    coverageCaption: "in albums",
    albumsByAccountTitle: "Albums by account",
    albumsCaption: "albums",
    breakdownTitle: "Breakdown by account",
    unknownAccount: "Account no longer signed in",
    noAlbums: "No albums yet.",
    noPhotos: "No photos cached for this account.",
  },
  "fr-CA": {
    title: "Statistiques des albums",
    description:
      "Calculées à partir du cache local, donc aussi disponibles hors ligne. Chaque photo ou vidéo est comptée une seule fois, même si elle fait partie de plusieurs albums.",
    refresh: "Actualiser les statistiques",
    loading: "Calcul des statistiques des albums…",
    loadFailed: "Impossible de calculer les statistiques des albums.",
    retry: "Réessayer",
    empty:
      "Aucun album ni aucune photo dans le cache pour l’instant. Synchronisez votre bibliothèque pour voir les statistiques.",
    albums: "Albums",
    inAlbums: "Dans un album",
    notInAlbums: "Dans aucun album",
    ofLibrary: (percent: string) => `${percent} de la bibliothèque`,
    shared: french("partagé", "partagés"),
    albumCount: french("album", "albums"),
    photoCount: french("photo", "photos"),
    unsynced: (count: number, formatted: string) =>
      `${french("album n’a", "albums n’ont")(count, formatted)} pas encore chargé leurs photos; « Dans un album » peut donc être sous-estimé. Ouvrez ces albums ou forcez une synchronisation complète pour les inclure.`,
    coverageTitle: "Couverture de la bibliothèque",
    coverageCaption: "dans des albums",
    albumsByAccountTitle: "Albums par compte",
    albumsCaption: "albums",
    breakdownTitle: "Répartition par compte",
    unknownAccount: "Compte qui n’est plus connecté",
    noAlbums: "Aucun album pour l’instant.",
    noPhotos: "Aucune photo dans le cache pour ce compte.",
  },
};

export type AlbumStatisticsLabels = (typeof messages)["en-CA"];

export function useAlbumStatisticsLabels(): AlbumStatisticsLabels {
  const { locale } = useI18n();
  return messages[locale];
}
