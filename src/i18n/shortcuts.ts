import { useI18n, type AppLocale } from "./index";
import type { ShortcutActionId, ShortcutGroup, ShortcutScope } from "../shortcuts/catalog";
import type { AppMenuLabels } from "../shortcuts/appMenu";

export interface ShortcutSettingsLabels {
  title: string;
  description: string;
  addShortcut: string;
  recording: string;
  recordingHint: string;
  unassigned: string;
  resetAll: string;
  replace: string;
  cancel: string;
  rejectedInvalid: string;
  saveFailed: string;
  addShortcutFor: (action: string) => string;
  removeShortcut: (shortcut: string, action: string) => string;
  resetAction: (action: string) => string;
  conflict: (shortcut: string, action: string) => string;
  rejectedReserved: (shortcut: string) => string;
  rejectedTextEditing: (shortcut: string) => string;
}

export interface ShortcutLabels {
  actions: Readonly<Record<ShortcutActionId, string>>;
  groups: Readonly<Record<ShortcutGroup, string>>;
  scopes: Readonly<Record<ShortcutScope, string>>;
  menu: AppMenuLabels;
  settings: ShortcutSettingsLabels;
}

const messages: Record<AppLocale, ShortcutLabels> = {
  "en-CA": {
    actions: {
      "photo.favorite": "Favorite or unfavorite",
      "photo.delete": "Delete",
      "photo.addToAlbum": "Add to album",
      "photo.share": "Share with a link",
      "photo.fixTime": "Fix date and time",
      "photo.copyToClipboard": "Copy images to clipboard",
      "photo.showInFolder": "Open in File Explorer",
      "photo.copyToFolder": "Copy to USB stick/folder",
      "photo.edit": "Edit",
      "photo.toggleInfo": "Show or hide info",
      "photo.rate0": "Clear star rating",
      "photo.rate1": "Rate 1 star",
      "photo.rate2": "Rate 2 stars",
      "photo.rate3": "Rate 3 stars",
      "photo.rate4": "Rate 4 stars",
      "photo.rate5": "Rate 5 stars",
      "view.previous": "Previous photo",
      "view.next": "Next photo",
      "view.close": "Close the viewer",
      "selection.selectAll": "Select all",
      "selection.clear": "Clear selection",
      "view.focusSearch": "Search",
      "view.toggleFilter": "Show or hide filters",
      "view.sortDirection": "Reverse sort order",
      "view.sortField": "Change sort field",
      "album.create": "Create new album",
      "nav.photos": "Go to Photos",
      "nav.albums": "Go to Albums",
      "nav.favorites": "Go to Favorites",
      "nav.people": "Go to People",
      "nav.maps": "Go to Map",
      "nav.calendar": "Go to Calendar",
      "nav.folders": "Go to Folders",
      "nav.phonePhotos": "Go to Phone Photos",
      "nav.deleted": "Go to Deleted",
      "nav.settings": "Open Settings",
    },
    groups: {
      photos: "Photos",
      viewer: "Photo viewer",
      selection: "Selection",
      view: "View",
      albums: "Albums",
      navigation: "Navigation",
    },
    scopes: {
      global: "Everywhere",
      browse: "Photo grid",
      viewer: "Photo viewer",
    },
    menu: {
      submenus: {
        "menu.photos": "Photos",
        "menu.albums": "Albums",
        "menu.share": "Share",
        "menu.edit": "Edit",
        "menu.view": "View",
        "menu.window": "Window",
        "menu.help": "Help",
      },
      items: {
        "photo.favorite": "Favorite",
        "photo.delete": "Delete",
        "photo.addToAlbum": "Add to album",
        "album.create": "Create new album",
        "nav.albums": "View albums",
        "photo.share": "Share with a link",
        "photo.copyToClipboard": "Copy images to clipboard",
        "photo.showInFolder": "Open in File Explorer",
        "photo.copyToFolder": "Copy to USB stick/folder",
        "nav.settings": "Settings…",
      },
      system: {
        "system.about": "About Immich Local App",
        "system.services": "Services",
        "system.hide": "Hide Immich Local App",
        "system.hideOthers": "Hide Others",
        "system.showAll": "Show All",
        "system.quit": "Quit Immich Local App",
        "system.undo": "Undo",
        "system.redo": "Redo",
        "system.cut": "Cut",
        "system.copy": "Copy",
        "system.paste": "Paste",
        "system.selectAll": "Select All",
        "system.fullscreen": "Toggle Full Screen",
        "system.minimize": "Minimize",
        "system.zoom": "Zoom",
        "system.closeWindow": "Close Window",
        "system.activityLog": "Activity Log",
      },
    },
    settings: {
      title: "Keyboard shortcuts",
      description:
        "Customize the keys used across the app. Changes apply right away, work the same on macOS and Windows, and are shown in the menu bar.",
      addShortcut: "Add shortcut",
      recording: "Press a key combination…",
      recordingHint: "Press Esc to cancel.",
      unassigned: "No shortcut",
      resetAll: "Reset all to defaults",
      replace: "Replace",
      cancel: "Cancel",
      rejectedInvalid: "That key can’t be used as a shortcut.",
      saveFailed: "Could not save your shortcuts.",
      addShortcutFor: (action) => `Add a shortcut for ${action}`,
      removeShortcut: (shortcut, action) => `Remove ${shortcut} from ${action}`,
      resetAction: (action) => `Reset ${action} to its default`,
      conflict: (shortcut, action) => `${shortcut} is already used for “${action}”.`,
      rejectedReserved: (shortcut) => `${shortcut} is reserved by the system or the app.`,
      rejectedTextEditing: (shortcut) =>
        `${shortcut} is used for editing text, so it can’t be used for this action.`,
    },
  },
  "fr-CA": {
    actions: {
      "photo.favorite": "Ajouter aux favoris ou retirer",
      "photo.delete": "Supprimer",
      "photo.addToAlbum": "Ajouter à un album",
      "photo.share": "Partager avec un lien",
      "photo.fixTime": "Corriger la date et l’heure",
      "photo.copyToClipboard": "Copier les images dans le presse-papiers",
      "photo.showInFolder": "Ouvrir dans l’Explorateur de fichiers",
      "photo.copyToFolder": "Copier vers une clé USB/un dossier",
      "photo.edit": "Modifier",
      "photo.toggleInfo": "Afficher ou masquer les infos",
      "photo.rate0": "Effacer la note",
      "photo.rate1": "Noter 1 étoile",
      "photo.rate2": "Noter 2 étoiles",
      "photo.rate3": "Noter 3 étoiles",
      "photo.rate4": "Noter 4 étoiles",
      "photo.rate5": "Noter 5 étoiles",
      "view.previous": "Photo précédente",
      "view.next": "Photo suivante",
      "view.close": "Fermer la visionneuse",
      "selection.selectAll": "Tout sélectionner",
      "selection.clear": "Effacer la sélection",
      "view.focusSearch": "Rechercher",
      "view.toggleFilter": "Afficher ou masquer les filtres",
      "view.sortDirection": "Inverser l’ordre de tri",
      "view.sortField": "Changer le champ de tri",
      "album.create": "Créer un nouvel album",
      "nav.photos": "Aller à Photos",
      "nav.albums": "Aller à Albums",
      "nav.favorites": "Aller à Favoris",
      "nav.people": "Aller à Personnes",
      "nav.maps": "Aller à Carte",
      "nav.calendar": "Aller à Calendrier",
      "nav.folders": "Aller à Dossiers",
      "nav.phonePhotos": "Aller à Photos du téléphone",
      "nav.deleted": "Aller à Supprimées",
      "nav.settings": "Ouvrir les paramètres",
    },
    groups: {
      photos: "Photos",
      viewer: "Visionneuse",
      selection: "Sélection",
      view: "Affichage",
      albums: "Albums",
      navigation: "Navigation",
    },
    scopes: {
      global: "Partout",
      browse: "Grille de photos",
      viewer: "Visionneuse",
    },
    menu: {
      submenus: {
        "menu.photos": "Photos",
        "menu.albums": "Albums",
        "menu.share": "Partager",
        "menu.edit": "Édition",
        "menu.view": "Affichage",
        "menu.window": "Fenêtre",
        "menu.help": "Aide",
      },
      items: {
        "photo.favorite": "Favori",
        "photo.delete": "Supprimer",
        "photo.addToAlbum": "Ajouter à un album",
        "album.create": "Créer un nouvel album",
        "nav.albums": "Afficher les albums",
        "photo.share": "Partager avec un lien",
        "photo.copyToClipboard": "Copier les images dans le presse-papiers",
        "photo.showInFolder": "Ouvrir dans l’Explorateur de fichiers",
        "photo.copyToFolder": "Copier vers une clé USB/un dossier",
        "nav.settings": "Paramètres…",
      },
      system: {
        "system.about": "À propos d’Immich Local App",
        "system.services": "Services",
        "system.hide": "Masquer Immich Local App",
        "system.hideOthers": "Masquer les autres",
        "system.showAll": "Tout afficher",
        "system.quit": "Quitter Immich Local App",
        "system.undo": "Annuler",
        "system.redo": "Rétablir",
        "system.cut": "Couper",
        "system.copy": "Copier",
        "system.paste": "Coller",
        "system.selectAll": "Tout sélectionner",
        "system.fullscreen": "Plein écran",
        "system.minimize": "Réduire",
        "system.zoom": "Agrandir",
        "system.closeWindow": "Fermer la fenêtre",
        "system.activityLog": "Journal d’activité",
      },
    },
    settings: {
      title: "Raccourcis clavier",
      description:
        "Personnalisez les touches utilisées dans l’application. Les changements s’appliquent immédiatement, fonctionnent de la même façon sur macOS et Windows, et s’affichent dans la barre de menus.",
      addShortcut: "Ajouter un raccourci",
      recording: "Appuyez sur une combinaison de touches…",
      recordingHint: "Appuyez sur Échap pour annuler.",
      unassigned: "Aucun raccourci",
      resetAll: "Tout réinitialiser",
      replace: "Remplacer",
      cancel: "Annuler",
      rejectedInvalid: "Cette touche ne peut pas servir de raccourci.",
      saveFailed: "Impossible d’enregistrer vos raccourcis.",
      addShortcutFor: (action) => `Ajouter un raccourci pour ${action}`,
      removeShortcut: (shortcut, action) => `Retirer ${shortcut} de ${action}`,
      resetAction: (action) => `Rétablir le raccourci par défaut de ${action}`,
      conflict: (shortcut, action) => `${shortcut} est déjà utilisé pour « ${action} ».`,
      rejectedReserved: (shortcut) => `${shortcut} est réservé par le système ou l’application.`,
      rejectedTextEditing: (shortcut) =>
        `${shortcut} sert à modifier du texte et ne peut pas être utilisé pour cette action.`,
    },
  },
};

export function useShortcutLabels(): ShortcutLabels {
  const { locale } = useI18n();
  return messages[locale];
}
