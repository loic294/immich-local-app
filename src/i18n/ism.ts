import { useI18n } from "./index";
import type { IsmErrorLabels } from "../utils/ismErrors";

type IsmLabels = {
  rename: string;
  move: string;
  trash: string;
  renameTitle: string;
  renameHint: string;
  fileName: string;
  moveTitle: string;
  moveHint: string;
  folder: string;
  trashTitle: string;
  trashBody: (count: number) => string;
  folderActions: string;
  createFolder: string;
  createFolderHint: (path: string) => string;
  folderName: string;
  moveFolder: string;
  moveFolderHint: string;
  newFolderPath: string;
  trashFolder: string;
  trashFolderBody: (path: string) => string;
  trashFolderCount: (count: number) => string;
  trashFolderLoading: string;
  cancel: string;
  confirm: string;
  working: string;
  partial: (done: number, total: number) => string;
  errors: IsmErrorLabels;
};

const messages: Record<"en-CA" | "fr-CA", IsmLabels> = {
  "en-CA": {
    rename: "Rename file…",
    move: "Move to folder…",
    trash: "Move to ISM trash",
    renameTitle: "Rename file",
    renameHint: "The original is renamed on the server; its sidecar files follow.",
    fileName: "File name",
    moveTitle: "Move to folder",
    moveHint:
      "Folder path inside the same ISM library, for example 2025/Trip. Sidecar files move too.",
    folder: "Folder",
    trashTitle: "Move to ISM trash",
    trashBody: (count) =>
      `${count === 1 ? "This photo and its sidecar files" : `These ${count} photos and their sidecar files`} will be moved to the ISM trash. They stay restorable in ISM until the trash is purged.`,
    folderActions: "Folder actions",
    createFolder: "New folder…",
    createFolderHint: (path) => `The folder is created inside ${path || "the library root"}.`,
    folderName: "Folder name",
    moveFolder: "Move or rename folder…",
    moveFolderHint: "New path inside the same ISM library.",
    newFolderPath: "New folder path",
    trashFolder: "Move folder to ISM trash",
    trashFolderBody: (path) =>
      `The folder ${path} and everything in it will be moved to the ISM trash. It stays restorable in ISM until the trash is purged.`,
    trashFolderCount: (count) =>
      count === 1
        ? "It contains 1 file. If anything changes before you confirm, nothing is trashed."
        : `It contains ${count} files. If anything changes before you confirm, nothing is trashed.`,
    trashFolderLoading: "Listing the folder contents…",
    cancel: "Cancel",
    confirm: "Confirm",
    working: "Working…",
    partial: (done, total) => `${done} of ${total} photos were updated before this error.`,
    errors: {
      maintenance_blocked:
        "ISM is busy with maintenance or another tool is writing to the library. Nothing was changed; try again later.",
      direct_writes_unavailable:
        "ISM cannot write to this library right now. Nothing was changed; check the ISM server.",
      revision_changed:
        "The file changed on the server since it was last synced. Nothing was changed; sync again, then retry.",
      destination_exists: "Something with that name already exists at the destination.",
      root_unavailable: "This ISM library is unavailable right now. Nothing was changed.",
      asset_identity:
        "ISM could not confirm that this file still belongs to the same Immich photo. Nothing was changed; sync again, then retry.",
      owner_transfer:
        "This change would move the photo to another Immich user, which ISM does not allow here. Nothing was changed.",
    },
  },
  "fr-CA": {
    rename: "Renommer le fichier…",
    move: "Déplacer vers un dossier…",
    trash: "Déplacer vers la corbeille ISM",
    renameTitle: "Renommer le fichier",
    renameHint: "L’original est renommé sur le serveur; ses fichiers annexes suivent.",
    fileName: "Nom du fichier",
    moveTitle: "Déplacer vers un dossier",
    moveHint:
      "Chemin du dossier dans la même bibliothèque ISM, par exemple 2025/Voyage. Les fichiers annexes suivent.",
    folder: "Dossier",
    trashTitle: "Déplacer vers la corbeille ISM",
    trashBody: (count) =>
      `${count < 2 ? "Cette photo et ses fichiers annexes seront déplacés" : `Ces ${count} photos et leurs fichiers annexes seront déplacés`} vers la corbeille ISM. Ils restent récupérables dans ISM tant que la corbeille n’est pas vidée.`,
    folderActions: "Actions du dossier",
    createFolder: "Nouveau dossier…",
    createFolderHint: (path) =>
      `Le dossier est créé dans ${path || "la racine de la bibliothèque"}.`,
    folderName: "Nom du dossier",
    moveFolder: "Déplacer ou renommer le dossier…",
    moveFolderHint: "Nouveau chemin dans la même bibliothèque ISM.",
    newFolderPath: "Nouveau chemin du dossier",
    trashFolder: "Déplacer le dossier vers la corbeille ISM",
    trashFolderBody: (path) =>
      `Le dossier ${path} et tout son contenu seront déplacés vers la corbeille ISM. Il reste récupérable dans ISM tant que la corbeille n’est pas vidée.`,
    trashFolderCount: (count) =>
      count <= 1
        ? `Il contient ${count} fichier. Si quelque chose change avant votre confirmation, rien n’est mis à la corbeille.`
        : `Il contient ${count} fichiers. Si quelque chose change avant votre confirmation, rien n’est mis à la corbeille.`,
    trashFolderLoading: "Inventaire du contenu du dossier…",
    cancel: "Annuler",
    confirm: "Confirmer",
    working: "En cours…",
    partial: (done, total) => `${done} photo(s) sur ${total} modifiée(s) avant cette erreur.`,
    errors: {
      maintenance_blocked:
        "ISM est en maintenance ou un autre outil écrit dans la bibliothèque. Rien n’a été modifié; réessayez plus tard.",
      direct_writes_unavailable:
        "ISM ne peut pas écrire dans cette bibliothèque pour le moment. Rien n’a été modifié; vérifiez le serveur ISM.",
      revision_changed:
        "Le fichier a changé sur le serveur depuis la dernière synchronisation. Rien n’a été modifié; synchronisez, puis réessayez.",
      destination_exists: "Un élément portant ce nom existe déjà à la destination.",
      root_unavailable:
        "Cette bibliothèque ISM est indisponible pour le moment. Rien n’a été modifié.",
      asset_identity:
        "ISM n’a pas pu confirmer que ce fichier correspond toujours à la même photo Immich. Rien n’a été modifié; synchronisez, puis réessayez.",
      owner_transfer:
        "Cette modification transférerait la photo à un autre utilisateur Immich, ce qu’ISM ne permet pas ici. Rien n’a été modifié.",
    },
  },
};

export function useIsmLabels(): IsmLabels {
  const { locale } = useI18n();
  return messages[locale];
}
