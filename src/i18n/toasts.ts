import { useI18n, type AppLocale } from "./index";

export interface ToastMessageValues {
  count: number;
  [param: string]: string | number | undefined;
}

type ToastMessage = (values: ToastMessageValues) => string;

export interface ToastMessageSource {
  key: string;
  params: Readonly<Record<string, string | number | undefined>>;
  count: number;
}

const text = (value: string | number | undefined) => (value === undefined ? "" : String(value));

const enNumber = (value: number) => value.toLocaleString("en-CA");
const frNumber = (value: number) => value.toLocaleString("fr-CA");

const enPhotos = (count: number) => `${enNumber(count)} ${count === 1 ? "photo" : "photos"}`;
// French uses the singular for 0 and 1.
const frPhotos = (count: number) => `${frNumber(count)} ${count < 2 ? "photo" : "photos"}`;
const frAgree = (count: number, singular: string, plural: string) =>
  count < 2 ? singular : plural;

const en = {
  "album.created": ({ name }) => `Album “${text(name)}” created`,
  "album.createdWithPhotos": ({ name, count }) =>
    `Album “${text(name)}” created with ${enPhotos(count)}`,
  "album.renamed": ({ name }) => `Album renamed to “${text(name)}”`,
  "album.deleted": ({ name }) => `Album “${text(name)}” deleted`,
  "album.photosAdded": ({ name, count }) =>
    name ? `${enPhotos(count)} added to “${text(name)}”` : `${enPhotos(count)} added to the album`,
  "album.savedLocally": ({ name }) =>
    name ? `Album “${text(name)}” saved on this computer` : "Album saved on this computer",
  "album.localCopyDeleted": ({ name }) =>
    name ? `Local copy of “${text(name)}” deleted` : "Local copy of the album deleted",
  "album.userAdded": () => "Person added to the album",
  "album.userRemoved": () => "Person removed from the album",
  "album.roleChanged": () => "Sharing role updated",
  "asset.favorited": ({ count }) => `${enPhotos(count)} added to favorites`,
  "asset.unfavorited": ({ count }) => `${enPhotos(count)} removed from favorites`,
  "asset.favoriteFailed": ({ count }) => `Couldn’t add ${enPhotos(count)} to favorites`,
  "asset.unfavoriteFailed": ({ count }) => `Couldn’t remove ${enPhotos(count)} from favorites`,
  "asset.trashed": ({ count }) => `${enPhotos(count)} moved to the trash`,
  "asset.archived": ({ count }) => `${enPhotos(count)} archived`,
  "asset.restored": ({ count }) => `${enPhotos(count)} restored`,
  "asset.deleteFailed": () => "Couldn’t move the photo to the trash or archive",
  "asset.restoreFailed": () => "Couldn’t restore the photo",
  "asset.copiedToClipboard": ({ count }) => `${enPhotos(count)} copied to the clipboard`,
  "asset.copyFailed": () => "Couldn’t copy to the clipboard",
  "asset.copiedToFolder": ({ count }) => `${enPhotos(count)} copied to the folder`,
  "asset.timeShifted": ({ count }) => `Capture time updated for ${enPhotos(count)}`,
  "asset.localOriginalRemoved": () => "Local high-resolution version removed",
  "asset.ratingFailed": () => "Couldn’t save the rating",
  "asset.descriptionFailed": () => "Couldn’t save the description",
  "media.editImported": ({ count }) =>
    count === 1 ? "Edited photo imported" : `${enNumber(count)} edited photos imported`,
  "media.error": ({ message }) => text(message),
  "share.linkCopied": () => "Share link copied to the clipboard",
  "connection.lost": () => "Server unreachable — working offline",
  "connection.restored": () => "Back online",
  "connection.queuedFlushed": ({ count }) =>
    `Back online — ${enNumber(count)} offline ${count === 1 ? "change" : "changes"} synced`,
  "sync.newPhotos": () => "New photos synced",
  "sync.upToDate": () => "Your library is up to date",
  "sync.fullStarted": () => "Full sync started",
} satisfies Record<string, ToastMessage>;

export type ToastKey = keyof typeof en;

const fr: Record<ToastKey, ToastMessage> = {
  "album.created": ({ name }) => `Album « ${text(name)} » créé`,
  "album.createdWithPhotos": ({ name, count }) =>
    `Album « ${text(name)} » créé avec ${frPhotos(count)}`,
  "album.renamed": ({ name }) => `Album renommé en « ${text(name)} »`,
  "album.deleted": ({ name }) => `Album « ${text(name)} » supprimé`,
  "album.photosAdded": ({ name, count }) =>
    name
      ? `${frPhotos(count)} ${frAgree(count, "ajoutée", "ajoutées")} à « ${text(name)} »`
      : `${frPhotos(count)} ${frAgree(count, "ajoutée", "ajoutées")} à l’album`,
  "album.savedLocally": ({ name }) =>
    name
      ? `Album « ${text(name)} » enregistré sur cet ordinateur`
      : "Album enregistré sur cet ordinateur",
  "album.localCopyDeleted": ({ name }) =>
    name ? `Copie locale de « ${text(name)} » supprimée` : "Copie locale de l’album supprimée",
  "album.userAdded": () => "Personne ajoutée à l’album",
  "album.userRemoved": () => "Personne retirée de l’album",
  "album.roleChanged": () => "Rôle de partage mis à jour",
  "asset.favorited": ({ count }) =>
    `${frPhotos(count)} ${frAgree(count, "ajoutée", "ajoutées")} aux favoris`,
  "asset.unfavorited": ({ count }) =>
    `${frPhotos(count)} ${frAgree(count, "retirée", "retirées")} des favoris`,
  "asset.favoriteFailed": ({ count }) => `Impossible d’ajouter ${frPhotos(count)} aux favoris`,
  "asset.unfavoriteFailed": ({ count }) => `Impossible de retirer ${frPhotos(count)} des favoris`,
  "asset.trashed": ({ count }) =>
    `${frPhotos(count)} ${frAgree(count, "déplacée", "déplacées")} dans la corbeille`,
  "asset.archived": ({ count }) => `${frPhotos(count)} ${frAgree(count, "archivée", "archivées")}`,
  "asset.restored": ({ count }) =>
    `${frPhotos(count)} ${frAgree(count, "restaurée", "restaurées")}`,
  "asset.deleteFailed": () => "Impossible de déplacer la photo vers la corbeille ou les archives",
  "asset.restoreFailed": () => "Impossible de restaurer la photo",
  "asset.copiedToClipboard": ({ count }) =>
    `${frPhotos(count)} ${frAgree(count, "copiée", "copiées")} dans le presse-papiers`,
  "asset.copyFailed": () => "Impossible de copier dans le presse-papiers",
  "asset.copiedToFolder": ({ count }) =>
    `${frPhotos(count)} ${frAgree(count, "copiée", "copiées")} dans le dossier`,
  "asset.timeShifted": ({ count }) => `Heure de prise de vue modifiée pour ${frPhotos(count)}`,
  "asset.localOriginalRemoved": () => "Version haute résolution locale supprimée",
  "asset.ratingFailed": () => "Impossible d’enregistrer la note",
  "asset.descriptionFailed": () => "Impossible d’enregistrer la description",
  "media.editImported": ({ count }) =>
    count < 2 ? "Photo modifiée importée" : `${frNumber(count)} photos modifiées importées`,
  "media.error": ({ message }) => text(message),
  "share.linkCopied": () => "Lien de partage copié dans le presse-papiers",
  "connection.lost": () => "Serveur inaccessible — mode hors ligne",
  "connection.restored": () => "De nouveau en ligne",
  "connection.queuedFlushed": ({ count }) =>
    `De nouveau en ligne — ${frNumber(count)} ${frAgree(count, "modification hors ligne synchronisée", "modifications hors ligne synchronisées")}`,
  "sync.newPhotos": () => "Nouvelles photos synchronisées",
  "sync.upToDate": () => "Votre bibliothèque est à jour",
  "sync.fullStarted": () => "Synchronisation complète lancée",
};

const messages: Record<AppLocale, Record<ToastKey, ToastMessage>> = {
  "en-CA": en,
  "fr-CA": fr,
};

export function resolveToastMessage(locale: AppLocale, item: ToastMessageSource): string {
  const message = (messages[locale] as Record<string, ToastMessage | undefined>)[item.key];
  if (!message) return item.key;
  return message({ ...item.params, count: item.count });
}

export interface ToastLabels {
  region: string;
  dismiss: string;
  message: (item: ToastMessageSource) => string;
}

const labels: Record<AppLocale, ToastLabels> = {
  "en-CA": {
    region: "Notifications",
    dismiss: "Dismiss notification",
    message: (item) => resolveToastMessage("en-CA", item),
  },
  "fr-CA": {
    region: "Notifications",
    dismiss: "Fermer la notification",
    message: (item) => resolveToastMessage("fr-CA", item),
  },
};

export function useToastLabels(): ToastLabels {
  const { locale } = useI18n();
  return labels[locale];
}
