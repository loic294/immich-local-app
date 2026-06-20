import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSettings } from "../hooks/useSettings";

export type AppLocale = "en-CA" | "fr-CA";

type TranslationLeaf = string;
type TranslationTree = {
  [key: string]: TranslationLeaf | TranslationTree;
};

type TranslationParams = Record<string, string | number>;

type I18nContextValue = {
  locale: AppLocale;
  setLocale: (next: AppLocale) => void;
  t: (key: string, params?: TranslationParams) => string;
};

const RESOURCES: Record<AppLocale, TranslationTree> = {
  "en-CA": {
    nav: {
      photos: "Photos",
      albums: "Albums",
      calendar: "Calendar",
      folders: "Folders",
      favorites: "Favorites",
      deleted: "Deleted",
      library: "Library",
      settings: "Settings",
    },
    settings: {
      title: "Settings",
      subtitle: "Manage your app preferences and cache",
      exit: "Exit Settings",
      languageTitle: "Language",
      languageDescription:
        "Choose your display language. The app applies this setting immediately and remembers it between launches.",
      languageLabel: "Display language",
      localeEnCa: "English (Canada)",
      localeFrCa: "Français (Canada)",
      languageSaving: "Saving language...",
      saveFailed: "Failed to save language setting.",
      sectionSync: "Sync",
      sectionNavigation: "Navigation Menu",
      sectionMyPhotos: "My Photos",
      sectionLivePhotos: "Live Photos",
      sectionCache: "Cache & Storage",
      sectionAccount: "Account",
      sectionUpdates: "App Updates",
      sectionAbout: "About",
      syncDescription:
        "Quick sync only checks for recent new photos and is fast. Full sync re-scans your entire library and refreshes all local metadata.",
      quickSyncRunning: "Quick sync running...",
      fullSyncStarting: "Starting full sync...",
      syncedCount: "{processed} / {total} photos synced",
      checkingNewAssets: "Checking for new assets...",
      lastFullSync: "Last full sync: {date}",
      readyToSync: "Ready to sync",
      quickSyncCta: "Quick Sync",
      quickSyncingCta: "Quick Syncing...",
      startFullSyncCta: "Starting Full Sync...",
      syncingCta: "Syncing...",
      forceFullSyncCta: "Force Full Sync",
      navigationDescription:
        "Choose which items appear in the sidebar. Settings is always shown.",
      myPhotosDescription:
        "Define which photos are considered yours using date ranges and a camera. The My Photos filter will match assets that satisfy any rule below.",
      myPhotosEmpty:
        "No rules yet. Add at least one rule to enable meaningful My Photos filtering.",
      myPhotosStartDate: "Start date",
      myPhotosCamera: "Camera",
      myPhotosSelectCamera: "Select a camera",
      myPhotosEndDate: "End date",
      myPhotosUseCurrentDate: "Use current date",
      myPhotosRemoveRule: "Remove rule",
      myPhotosAddRule: "Add rule",
      myPhotosSaveRules: "Save My Photos Rules",
      livePhotosAutoplay: "Automatically play live photos on hover",
      livePhotosHelp:
        "When disabled, you can still play live photos manually using the button in the viewer.",
      localFolderLabel: "Local Files Folder",
      localFolderPlaceholder: "Choose a folder for copied local files",
      browse: "Browse",
      save: "Save",
      saving: "Saving...",
      openLocalFolder: "Open local folder",
      localFolderHelp:
        "Selected assets are copied here when using Open in file explorer. This folder is separate from the app cache.",
      cacheLocation: "Cache Location",
      open: "Open",
      storageUsage: "Storage Usage",
      totalCacheSize: "Total Cache Size",
      videos: "Videos",
      thumbnails: "Thumbnails",
      fileCountSingular: "{count} file",
      fileCountPlural: "{count} files",
      clearCache: "Clear Cache",
      clearCacheHelp:
        "Clearing the cache will not affect your photos. They will be re-downloaded as needed.",
      accountDescription:
        "Sign out to connect to a different Immich server or change your API key.",
      signOut: "Sign Out",
      currentVersion: "Current version: {version}",
      updatesChecking: "Checking for updates...",
      updatesDownloading: "Downloading update {version}...",
      updatesLatest: "You are on the latest version.",
      updatesCheckFailed: "Failed to check for updates.",
      restartInstall: "Restart to install {version}",
      checkForUpdates: "Check for Updates",
      aboutDescription:
        "A local photo browsing app for Immich servers with support for live photos, albums, and offline caching.",
      failedSaveLocalFolder: "Failed to save local folder path.",
      failedOpenFolderPicker: "Failed to open folder picker.",
      clearCacheConfirm:
        "Are you sure you want to clear all cached videos and thumbnails? This will free up space but may take time to reload media.",
      failedSaveMyPhotosRules: "Failed to save My Photos rules.",
      failedOpenLocalFolder: "Failed to open local folder in file explorer.",
      failedOpenCacheFolder: "Failed to open cache folder in file explorer.",
    },
    auth: {
      signInTitle: "Sign in to Immich",
      connectAt: "Connect to your Immich server at {serverUrl}",
      modeDev: "Dev Mode",
      modeApiKey: "API Key",
      modePassword: "Username / Password",
      apiKeyHelp: "Paste your Immich API key to sign in directly.",
      apiKeyLabel: "API Key",
      apiKeyPlaceholder: "immich_api_key...",
      apiKeySubmit: "Sign in with API Key",
      passwordHelp: "Sign in with your Immich account email and password.",
      emailLabel: "Email",
      emailPlaceholder: "you@example.com",
      passwordLabel: "Password",
      passwordPlaceholder: "Enter your password",
      passwordSubmit: "Sign in with Password",
      signingIn: "Signing in...",
      back: "Back",
      startOauth: "Start OAuth in Browser",
      openingBrowser: "Opening browser...",
      oauthHelpA:
        "After signing in, you should be redirected back to this app automatically.",
      oauthHelpB:
        "If it does not complete, paste either the full redirect URL or just the value of the code parameter below.",
      authCodeLabel: "Authorization Code or Callback URL",
      authCodePlaceholder: "code=... or app.immich:///oauth-callback?...",
      verifyCode: "Verify Code",
      verifying: "Verifying...",
      cancel: "Cancel",
    },
    server: {
      title: "Connect to Immich",
      subtitle: "Enter your Immich server URL to get started.",
      label: "Server URL",
      placeholder: "https://immich.example.com",
      hint: "e.g. http://localhost:2283 or https://immich.example.com",
      connecting: "Connecting...",
      next: "Next",
    },
    offline: {
      title: "Offline",
      pendingSingular: "{count} change pending",
      pendingPlural: "{count} changes pending",
    },
    syncCard: {
      syncedCount: "{processed} / {total} photos synced",
      checking: "Checking for new assets...",
      complete: "Sync Complete",
      ready: "Ready to sync photos",
      syncing: "Syncing...",
      checkingShort: "Checking...",
      checkForNew: "Check for New Photos",
    },
    updateNotifier: {
      downloading: "Downloading update...",
      ready: "Update {version} is ready",
      restartHint: "Restart to finish installing.",
      restarting: "Restarting...",
      restartNow: "Restart now",
      dismissAria: "Dismiss update notification",
    },
    header: {
      searchPhotos: "Search your photos",
      filter: "Filter",
      filterAria: "Filter photos",
      accountMenuAria: "Open account menu",
      signOut: "Sign out",
      profileAlt: "Profile",
    },
    topBar: {
      cancel: "Cancel",
      selectAll: "Select All",
      selectedCount: "{count} selected",
      delete: "Delete",
      archiveConfirmTitle: "Archive photos?",
      archiveConfirmBody:
        "This will archive {count} selected photo{suffix}. You can restore them later.",
      archiveFailed: "Failed to archive photos",
      archiving: "Archiving...",
      archive: "Archive",
    },
    photos: {
      genericError: "An error occurred",
      searchLabel: "Search",
    },
    calendar: {
      title: "Calendar",
      loadTimelineFailed: "Could not load timeline",
      loadingTimeline: "Loading timeline...",
      noPhotos: "No photos found.",
      monthSearchPlaceholder: "Calendar",
      backAria: "Back",
      monthCount: "({count} photo{suffix})",
      loadMonthFailed: "Could not load photos for this month",
    },
    folders: {
      searchPlaceholder: "Search folder photos",
      backAria: "Back",
      title: "Folders",
      loadFoldersFailed: "Could not load folders",
      subfolders: "Subfolders",
      loadFolderFailed: "Could not load photos for this folder",
      emptyFolder: "This folder is empty.",
      root: "root",
    },
    albums: {
      searchInAlbum: "Search photos in this album",
      searchAlbums: "Search albums",
      backToAlbumsAria: "Back to albums",
      saveLocally: "Save Locally",
      openExplorer: "Open in File Explorer",
      shareAlbum: "Share Album",
      saving: "Saving...",
      loadAlbumFailed: "Could not load album photos",
      title: "Albums",
      filterAll: "All",
      filterMine: "My albums",
      filterShared: "Shared with me",
      loadAlbumsFailed: "Could not load albums",
      loadingAlbums: "Loading albums...",
      noAlbumsForFilter: "No albums found for this filter.",
      albumsCount: "({count} albums)",
      unknownDate: "Unknown date",
      lightroomCta: "View more photos on Lightroom",
    },
    filters: {
      clearAllAria: "Clear all filters",
      clear: "Clear",
      favoritesAria: "Show only favorites",
      favorites: "Favorites",
      myPhotosAria: "Show only my photos",
      myPhotos: "My Photos",
      ratingGte: "Rating and above",
      ratingEq: "Rating exactly",
      ratingLte: "Rating and below",
      starsAria: "{count} star{suffix}",
      mediaTypeAria: "Filter by media type",
      allTypes: "All types",
      mediaPhoto: "Photo",
      mediaRaw: "RAW",
      mediaPhotoRaw: "Photo + RAW",
      mediaVideo: "Video",
      cameraAria: "Filter by camera",
      loading: "Loading...",
      allCameras: "All cameras",
      peopleAria: "Filter by person",
      allPeople: "All people",
      noPeopleFound: "No people found",
      unnamedPerson: "Unnamed",
      sortAria: "Sort photos",
      sort: "Sort",
      sortBy: "Sort by",
      sortOrder: "Order",
      sortDateCaptured: "Date Captured",
      sortFilename: "Filename",
      sortDescending: "Descending",
      sortAscending: "Ascending",
    },
    photoGrid: {
      loaded: "{count} loaded",
      loadedAll: "{count} loaded (all)",
      jumpToDateAria: "Jump to date",
      jumpToDate: "Jump to Date",
      loadingMoreAssets: "Loading more assets...",
      noMoreAssets: "No more assets to load.",
      backAria: "Back",
      playLiveAgainAria: "Play live photo again",
      toggleInfoAria: "Toggle info panel",
      info: "Info",
      previousImageAria: "Previous image",
      nextImageAria: "Next image",
      loadingVideo: "Loading video...",
      loadingPreview: "Loading preview...",
      openFullscreenAria: "Open {name} in full screen",
      selectPhotoAria: "Select photo",
      deselectPhotoAria: "Deselect photo",
      liveBadge: "LIVE",
      setRatingAria: "Set rating to {value}",
      removeFavorite: "Remove favorite",
      addFavorite: "Add to favorites",
      unarchive: "Unarchive",
      archive: "Archive",
      toggleFavoriteAria: "Toggle favorite",
      toggleArchiveAria: "Toggle archive",
      myPhotoBadge: "My Photo",
      unknownMake: "Unknown make",
      unknownCamera: "Unknown camera",
      unknownDimensions: "Unknown dimensions",
      loadingCachedMetadata: "Loading cached metadata...",
      labelFocalLength: "FOCAL LENGTH",
      labelShutterSpeed: "SHUTTER SPEED",
      labelAperture: "APERTURE",
      labelIso: "ISO",
      labelCaptured: "Captured",
      labelDescription: "Description",
      descriptionPlaceholder: "Add a description",
      savingDescription: "Saving description...",
      labelFileName: "File Name",
      labelFileLocation: "File Location",
      labelLocation: "Location",
      labelGps: "GPS",
      mapTitle: "Photo location map",
      labelPeople: "People",
      labelTags: "Tags",
      unknownValue: "-",
      datePickerTitle: "Jump to Date",
      datePickerYear: "Year",
      datePickerMonth: "Month",
      datePickerNoPhotos: "No photos available for this month",
      datePickerCancel: "Cancel",
      closeDatePickerAria: "Close date picker",
      openThumbnailAria: "Open {name}",
    },
  },
  "fr-CA": {
    nav: {
      photos: "Photos",
      albums: "Albums",
      calendar: "Calendrier",
      folders: "Dossiers",
      favorites: "Favoris",
      deleted: "Supprimés",
      library: "Bibliothèque",
      settings: "Paramètres",
    },
    settings: {
      title: "Paramètres",
      subtitle: "Gérez les préférences de l'application et le cache",
      exit: "Quitter les paramètres",
      languageTitle: "Langue",
      languageDescription:
        "Choisissez la langue d'affichage. L'application applique ce réglage immédiatement et le conserve entre les redémarrages.",
      languageLabel: "Langue d'affichage",
      localeEnCa: "English (Canada)",
      localeFrCa: "Français (Canada)",
      languageSaving: "Enregistrement de la langue...",
      saveFailed: "Impossible d'enregistrer le parametre de langue.",
      sectionSync: "Synchronisation",
      sectionNavigation: "Menu de navigation",
      sectionMyPhotos: "Mes photos",
      sectionLivePhotos: "Photos Live",
      sectionCache: "Cache et stockage",
      sectionAccount: "Compte",
      sectionUpdates: "Mises a jour de l'application",
      sectionAbout: "A propos",
      syncDescription:
        "La synchro rapide verifie seulement les photos recentes et reste rapide. La synchro complete rescane toute votre bibliotheque et rafraichit toutes les metadonnees locales.",
      quickSyncRunning: "Synchro rapide en cours...",
      fullSyncStarting: "Demarrage de la synchro complete...",
      syncedCount: "{processed} / {total} photos synchronisees",
      checkingNewAssets: "Verification des nouveaux elements...",
      lastFullSync: "Derniere synchro complete : {date}",
      readyToSync: "Pret a synchroniser",
      quickSyncCta: "Synchro rapide",
      quickSyncingCta: "Synchro rapide...",
      startFullSyncCta: "Demarrage de la synchro complete...",
      syncingCta: "Synchronisation...",
      forceFullSyncCta: "Forcer la synchronisation complete",
      navigationDescription:
        "Choisissez les elements affiches dans la barre laterale. Parametres est toujours visible.",
      myPhotosDescription:
        "Definissez quelles photos sont les votres avec des plages de dates et un appareil. Le filtre Mes photos correspondra aux elements qui respectent au moins une regle.",
      myPhotosEmpty:
        "Aucune regle pour le moment. Ajoutez au moins une regle pour activer un filtre Mes photos utile.",
      myPhotosStartDate: "Date de debut",
      myPhotosCamera: "Appareil",
      myPhotosSelectCamera: "Selectionner un appareil",
      myPhotosEndDate: "Date de fin",
      myPhotosUseCurrentDate: "Utiliser la date actuelle",
      myPhotosRemoveRule: "Supprimer la regle",
      myPhotosAddRule: "Ajouter une regle",
      myPhotosSaveRules: "Enregistrer les regles Mes photos",
      livePhotosAutoplay: "Lire automatiquement les photos Live au survol",
      livePhotosHelp:
        "Quand c'est desactive, vous pouvez toujours lire les photos Live manuellement avec le bouton dans le visionneur.",
      localFolderLabel: "Dossier des fichiers locaux",
      localFolderPlaceholder: "Choisir un dossier pour les copies locales",
      browse: "Parcourir",
      save: "Enregistrer",
      saving: "Enregistrement...",
      openLocalFolder: "Ouvrir le dossier local",
      localFolderHelp:
        "Les elements selectionnes sont copies ici avec Ouvrir dans l'explorateur. Ce dossier est separe du cache de l'application.",
      cacheLocation: "Emplacement du cache",
      open: "Ouvrir",
      storageUsage: "Utilisation du stockage",
      totalCacheSize: "Taille totale du cache",
      videos: "Videos",
      thumbnails: "Miniatures",
      fileCountSingular: "{count} fichier",
      fileCountPlural: "{count} fichiers",
      clearCache: "Vider le cache",
      clearCacheHelp:
        "Vider le cache n'affectera pas vos photos. Elles seront retéléchargees au besoin.",
      accountDescription:
        "Deconnectez-vous pour vous connecter a un autre serveur Immich ou changer votre cle API.",
      signOut: "Se deconnecter",
      currentVersion: "Version actuelle : {version}",
      updatesChecking: "Verification des mises a jour...",
      updatesDownloading: "Telechargement de la mise a jour {version}...",
      updatesLatest: "Vous etes sur la derniere version.",
      updatesCheckFailed: "Echec de la verification des mises a jour.",
      restartInstall: "Redemarrer pour installer {version}",
      checkForUpdates: "Verifier les mises a jour",
      aboutDescription:
        "Une application locale de navigation photo pour les serveurs Immich, avec prise en charge des photos Live, des albums et du cache hors ligne.",
      failedSaveLocalFolder:
        "Impossible d'enregistrer le chemin du dossier local.",
      failedOpenFolderPicker: "Impossible d'ouvrir le selecteur de dossier.",
      clearCacheConfirm:
        "Etes-vous sur de vouloir effacer tous les videos et miniatures en cache ? Cela liberera de l'espace mais peut prendre du temps pour recharger les medias.",
      failedSaveMyPhotosRules:
        "Impossible d'enregistrer les regles Mes photos.",
      failedOpenLocalFolder:
        "Impossible d'ouvrir le dossier local dans l'explorateur de fichiers.",
      failedOpenCacheFolder:
        "Impossible d'ouvrir le dossier cache dans l'explorateur de fichiers.",
    },
    auth: {
      signInTitle: "Se connecter a Immich",
      connectAt: "Connectez-vous a votre serveur Immich : {serverUrl}",
      modeDev: "Mode dev",
      modeApiKey: "Clé API",
      modePassword: "Nom d'utilisateur / Mot de passe",
      apiKeyHelp:
        "Collez votre clé API Immich pour vous connecter directement.",
      apiKeyLabel: "Clé API",
      apiKeyPlaceholder: "immich_api_key...",
      apiKeySubmit: "Se connecter avec une clé API",
      passwordHelp:
        "Connectez-vous avec l'email et le mot de passe de votre compte Immich.",
      emailLabel: "Email",
      emailPlaceholder: "vous@exemple.com",
      passwordLabel: "Mot de passe",
      passwordPlaceholder: "Entrez votre mot de passe",
      passwordSubmit: "Se connecter avec mot de passe",
      signingIn: "Connexion...",
      back: "Retour",
      startOauth: "Démarrer OAuth dans le navigateur",
      openingBrowser: "Ouverture du navigateur...",
      oauthHelpA:
        "Après connexion, vous devriez être redirigé automatiquement vers cette application.",
      oauthHelpB:
        "Si ce n'est pas complet, collez soit l'URL de redirection complète, soit seulement la valeur du paramètre code ci-dessous.",
      authCodeLabel: "Code d'autorisation ou URL de rappel",
      authCodePlaceholder: "code=... ou app.immich:///oauth-callback?...",
      verifyCode: "Vérifier le code",
      verifying: "Vérification...",
      cancel: "Annuler",
    },
    server: {
      title: "Connexion à Immich",
      subtitle: "Entrez l'URL de votre serveur Immich pour commencer.",
      label: "URL du serveur",
      placeholder: "https://immich.example.com",
      hint: "ex. http://localhost:2283 ou https://immich.example.com",
      connecting: "Connexion...",
      next: "Suivant",
    },
    offline: {
      title: "Hors ligne",
      pendingSingular: "{count} changement en attente",
      pendingPlural: "{count} changements en attente",
    },
    syncCard: {
      syncedCount: "{processed} / {total} photos synchronisées",
      checking: "Vérification des nouveaux éléments...",
      complete: "Synchronisation terminée",
      ready: "Prêt à synchroniser les photos",
      syncing: "Synchronisation...",
      checkingShort: "Vérification...",
      checkForNew: "Synchroniser",
    },
    updateNotifier: {
      downloading: "Téléchargement de la mise à jour...",
      ready: "La mise à jour {version} est prête",
      restartHint: "Redémarrez pour terminer l'installation.",
      restarting: "Redémarrage...",
      restartNow: "Redémarrer maintenant",
      dismissAria: "Masquer la notification de mise à jour",
    },
    header: {
      searchPhotos: "Rechercher vos photos",
      filter: "Filtrer",
      filterAria: "Filtrer les photos",
      accountMenuAria: "Ouvrir le menu du compte",
      signOut: "Se déconnecter",
      profileAlt: "Profil",
    },
    topBar: {
      cancel: "Annuler",
      selectAll: "Tout sélectionner",
      selectedCount: "{count} sélectionnées",
      delete: "Supprimer",
      archiveConfirmTitle: "Supprimer les photos ?",
      archiveConfirmBody:
        "Ceci supprimera {count} photo{suffix} sélectionnée{suffix}. Vous pourrez les restaurer plus tard.",
      archiveFailed: "Impossible de supprimer les photos",
      archiving: "Suppression...",
      archive: "Supprimer",
    },
    photos: {
      genericError: "Une erreur est survenue",
      searchLabel: "Recherche",
    },
    calendar: {
      title: "Calendrier",
      loadTimelineFailed: "Impossible de charger la chronologie",
      loadingTimeline: "Chargement de la chronologie...",
      noPhotos: "Aucune photo trouvée.",
      monthSearchPlaceholder: "Calendrier",
      backAria: "Retour",
      monthCount: "({count} photo{suffix})",
      loadMonthFailed: "Impossible de charger les photos de ce mois",
    },
    folders: {
      searchPlaceholder: "Rechercher dans les photos du dossier",
      backAria: "Retour",
      title: "Dossiers",
      loadFoldersFailed: "Impossible de charger les dossiers",
      subfolders: "Sous-dossiers",
      loadFolderFailed: "Impossible de charger les photos de ce dossier",
      emptyFolder: "Ce dossier est vide.",
      root: "racine",
    },
    albums: {
      searchInAlbum: "Rechercher des photos dans cet album",
      searchAlbums: "Rechercher des albums",
      backToAlbumsAria: "Retour aux albums",
      saveLocally: "Enregistrer localement",
      openExplorer: "Ouvrir dans l'explorateur",
      shareAlbum: "Partager l'album",
      saving: "Enregistrement...",
      loadAlbumFailed: "Impossible de charger les photos de l'album",
      title: "Albums",
      filterAll: "Tous",
      filterMine: "Mes albums",
      filterShared: "Partages avec moi",
      loadAlbumsFailed: "Impossible de charger les albums",
      loadingAlbums: "Chargement des albums...",
      noAlbumsForFilter: "Aucun album trouvé pour ce filtre.",
      albumsCount: "({count} albums)",
      unknownDate: "Date inconnue",
      lightroomCta: "Voir plus de photos sur Lightroom",
    },
    filters: {
      clearAllAria: "Effacer tous les filtres",
      clear: "Effacer",
      favoritesAria: "Afficher seulement les favoris",
      favorites: "Favoris",
      myPhotosAria: "Afficher seulement mes photos",
      myPhotos: "Mes photos",
      ratingGte: "Note et plus",
      ratingEq: "Note exacte",
      ratingLte: "Note et moins",
      starsAria: "{count} étoile{suffix}",
      mediaTypeAria: "Filtrer par type de media",
      allTypes: "Tous les formats",
      mediaPhoto: "Photo",
      mediaRaw: "RAW",
      mediaPhotoRaw: "Photo + RAW",
      mediaVideo: "Vidéo",
      cameraAria: "Filtrer par appareil",
      loading: "Chargement...",
      allCameras: "Tous les appareils photos",
      peopleAria: "Filtrer par personne",
      allPeople: "Toutes les personnes",
      noPeopleFound: "Aucune personne trouvée",
      unnamedPerson: "Sans nom",
      sortAria: "Trier les photos",
      sort: "Trier",
      sortBy: "Trier par",
      sortOrder: "Ordre",
      sortDateCaptured: "Date de prise",
      sortFilename: "Nom de fichier",
      sortDescending: "Décroissant",
      sortAscending: "Croissant",
    },
    photoGrid: {
      loaded: "{count} charges",
      loadedAll: "{count} charges (tous)",
      jumpToDateAria: "Aller à une date",
      jumpToDate: "Aller à la date",
      loadingMoreAssets: "Chargement de plus d'éléments...",
      noMoreAssets: "Aucun autre élément à charger.",
      backAria: "Retour",
      playLiveAgainAria: "Relire la photo Live",
      toggleInfoAria: "Basculer le panneau d'info",
      info: "Info",
      previousImageAria: "Image précédente",
      nextImageAria: "Image suivante",
      loadingVideo: "Chargement de la video...",
      loadingPreview: "Chargement de l'aperçu...",
      openFullscreenAria: "Ouvrir {name} en plein écran",
      selectPhotoAria: "Sélectionner la photo",
      deselectPhotoAria: "Désélectionner la photo",
      liveBadge: "LIVE",
      setRatingAria: "Définir la note à {value}",
      removeFavorite: "Retirer des favoris",
      addFavorite: "Ajouter aux favoris",
      unarchive: "Restaurer",
      archive: "Supprimer",
      toggleFavoriteAria: "Basculer favori",
      toggleArchiveAria: "Basculer suppression",
      myPhotoBadge: "Ma photo",
      unknownMake: "Marque inconnue",
      unknownCamera: "Appareil inconnu",
      unknownDimensions: "Dimensions inconnues",
      loadingCachedMetadata: "Chargement des métadonnées en cache...",
      labelFocalLength: "LONGUEUR FOCALE",
      labelShutterSpeed: "VITESSE D'OBTURATION",
      labelAperture: "OUVERTURE",
      labelIso: "ISO",
      labelCaptured: "Capturée",
      labelDescription: "Description",
      descriptionPlaceholder: "Ajouter une description",
      savingDescription: "Enregistrement de la description...",
      labelFileName: "Nom du fichier",
      labelFileLocation: "Emplacement du fichier",
      labelLocation: "Emplacement",
      labelGps: "GPS",
      mapTitle: "Carte de l'emplacement de la photo",
      labelPeople: "Personnes",
      labelTags: "Étiquettes",
      unknownValue: "-",
      datePickerTitle: "Aller à la date",
      datePickerYear: "Année",
      datePickerMonth: "Mois",
      datePickerNoPhotos: "Aucune photo disponible pour ce mois",
      datePickerCancel: "Annuler",
      closeDatePickerAria: "Fermer le sélecteur de date",
      openThumbnailAria: "Ouvrir {name}",
    },
  },
};

const I18nContext = createContext<I18nContextValue | null>(null);

function normalizeLocale(raw: string | null | undefined): AppLocale {
  if (!raw) {
    return "en-CA";
  }

  const value = raw.replace("_", "-").toLowerCase();
  if (value.startsWith("fr")) {
    return "fr-CA";
  }
  return "en-CA";
}

function detectSystemLocale(): AppLocale {
  const system = Intl.DateTimeFormat().resolvedOptions().locale;
  return normalizeLocale(system);
}

function resolveTranslation(locale: AppLocale, key: string): string {
  const segments = key.split(".");
  let cursor: TranslationLeaf | TranslationTree | undefined = RESOURCES[locale];

  for (const segment of segments) {
    if (cursor && typeof cursor === "object" && segment in cursor) {
      cursor = cursor[segment];
      continue;
    }

    cursor = undefined;
    break;
  }

  if (typeof cursor === "string") {
    return cursor;
  }

  const fallbackCursor = segments.reduce<
    TranslationLeaf | TranslationTree | undefined
  >((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    return current[segment];
  }, RESOURCES["en-CA"]);

  if (typeof fallbackCursor === "string") {
    return fallbackCursor;
  }

  return key;
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = params[token];
    return value === undefined ? match : String(value);
  });
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const settingsQuery = useSettings();
  const [locale, setLocaleState] = useState<AppLocale>(detectSystemLocale);

  useEffect(() => {
    if (!settingsQuery.data?.locale) {
      return;
    }

    setLocaleState(normalizeLocale(settingsQuery.data.locale));
  }, [settingsQuery.data?.locale]);

  const setLocale = useCallback((next: AppLocale) => {
    setLocaleState(normalizeLocale(next));
  }, []);

  const t = useCallback(
    (key: string, params?: TranslationParams) => {
      const template = resolveTranslation(locale, key);
      return interpolate(template, params);
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
