import type { ActivityErrorKind, ActivityLevel, ActivityTimeRange } from "../types/activityLog";
import { useI18n, type AppLocale } from "./index";

export interface ClearLogDialogLabels {
  title: string;
  body: string;
  confirm: string;
  confirming: string;
  cancel: string;
  failed: (reason: string) => string;
}

export interface ActivityLogLabels {
  windowTitle: string;
  formatNumber: (value: number) => string;
  levelGroup: string;
  levelNames: Record<ActivityLevel, string>;
  category: string;
  allCategories: string;
  search: string;
  searchPlaceholder: string;
  clearSearch: string;
  slowOnly: string;
  slowOnlyTitle: string;
  range: string;
  ranges: Record<ActivityTimeRange, string>;
  previousSessions: string;
  previousSessionsTitle: string;
  previousSessionsLoading: string;
  verbose: string;
  verboseHint: string;
  copy: string;
  copyTitle: string;
  copied: (lines: number) => string;
  copyFailed: string;
  clear: string;
  clearTitle: string;
  openLogFolder: string;
  openLogFolderFailed: string;
  counter: (shown: number, total: number) => string;
  footerNote: string;
  listLabel: string;
  emptyTitle: string;
  emptyBody: string;
  noMatchTitle: string;
  noMatchBody: string;
  resetFilters: string;
  jumpToLatest: string;
  newEntries: (count: number) => string;
  slowBadge: string;
  slowBadgeTitle: (duration: string) => string;
  unexpectedEnd: string;
  errors: Record<ActivityErrorKind, (reason: string) => string>;
  dialog: ClearLogDialogLabels;
}

const numberFormats: Record<AppLocale, Intl.NumberFormat> = {
  "en-CA": new Intl.NumberFormat("en-CA"),
  "fr-CA": new Intl.NumberFormat("fr-CA"),
};

const formatEn = (value: number) => numberFormats["en-CA"].format(value);
const formatFr = (value: number) => numberFormats["fr-CA"].format(value);

const messages: Record<AppLocale, ActivityLogLabels> = {
  "en-CA": {
    windowTitle: "Activity Log",
    formatNumber: formatEn,
    levelGroup: "Levels",
    levelNames: { error: "Errors", warn: "Warnings", info: "Info", debug: "Debug" },
    category: "Category",
    allCategories: "All categories",
    search: "Search the log",
    searchPlaceholder: "Search…",
    clearSearch: "Clear search",
    slowOnly: "Slow only",
    slowOnlyTitle: "Only show entries flagged as slow",
    range: "Time range",
    ranges: {
      all: "All time",
      "1m": "Last minute",
      "5m": "Last 5 minutes",
      "15m": "Last 15 minutes",
      "60m": "Last hour",
    },
    previousSessions: "Previous sessions",
    previousSessionsTitle: "Also show entries saved by earlier launches of the app",
    previousSessionsLoading: "Loading previous sessions…",
    verbose: "Verbose",
    verboseHint: "Includes chatty debug entries; resets on restart",
    copy: "Copy",
    copyTitle: "Copy the entries shown (newest 1,500 at most) to paste them into a chat",
    copied: (lines) => `Copied ${formatEn(lines)} ${lines === 1 ? "line" : "lines"}`,
    copyFailed: "Couldn’t copy to the clipboard",
    clear: "Clear",
    clearTitle: "Delete the whole log, including the saved files",
    openLogFolder: "Open log folder",
    openLogFolderFailed: "Couldn’t open the log folder",
    counter: (shown, total) =>
      `${formatEn(shown)} of ${formatEn(total)} ${total === 1 ? "entry" : "entries"}`,
    footerNote: "Logs may contain file and album names. Check them before sharing.",
    listLabel: "Activity log entries",
    emptyTitle: "Nothing logged yet",
    emptyBody: "Activity shows up here as you use the app.",
    noMatchTitle: "No entries match these filters",
    noMatchBody: "Try turning on more levels or widening the time range.",
    resetFilters: "Reset filters",
    jumpToLatest: "Jump to latest",
    newEntries: (count) => `${formatEn(count)} new`,
    slowBadge: "SLOW",
    slowBadgeTitle: (duration) => `Slower than expected: ${duration}`,
    unexpectedEnd:
      "The previous session didn’t end cleanly — the app may have crashed or been closed unexpectedly.",
    errors: {
      poll: (reason) => `Can’t read the activity log: ${reason}`,
      history: (reason) => `Couldn’t load previous sessions: ${reason}`,
      verbose: (reason) => `Couldn’t change verbose mode: ${reason}`,
    },
    dialog: {
      title: "Clear the activity log?",
      body: "This deletes every entry, including the files saved on this computer. This can’t be undone.",
      confirm: "Clear log",
      confirming: "Clearing…",
      cancel: "Cancel",
      failed: (reason) => `Couldn’t clear the log: ${reason}`,
    },
  },
  "fr-CA": {
    windowTitle: "Journal d’activité",
    formatNumber: formatFr,
    levelGroup: "Niveaux",
    levelNames: { error: "Erreurs", warn: "Avertissements", info: "Infos", debug: "Débogage" },
    category: "Catégorie",
    allCategories: "Toutes les catégories",
    search: "Rechercher dans le journal",
    searchPlaceholder: "Rechercher…",
    clearSearch: "Effacer la recherche",
    slowOnly: "Lents seulement",
    slowOnlyTitle: "Afficher seulement les entrées signalées comme lentes",
    range: "Période",
    ranges: {
      all: "Tout",
      "1m": "Dernière minute",
      "5m": "5 dernières minutes",
      "15m": "15 dernières minutes",
      "60m": "Dernière heure",
    },
    previousSessions: "Sessions précédentes",
    previousSessionsTitle:
      "Afficher aussi les entrées enregistrées lors des lancements précédents de l’application",
    previousSessionsLoading: "Chargement des sessions précédentes…",
    verbose: "Détaillé",
    verboseHint: "Inclut les entrées de débogage bavardes; se réinitialise au redémarrage",
    copy: "Copier",
    copyTitle: "Copier les entrées affichées (1 500 au plus) pour les coller dans une conversation",
    copied: (lines) => `${formatFr(lines)} ${lines <= 1 ? "ligne copiée" : "lignes copiées"}`,
    copyFailed: "Impossible de copier dans le presse-papiers",
    clear: "Effacer",
    clearTitle: "Supprimer tout le journal, y compris les fichiers enregistrés",
    openLogFolder: "Ouvrir le dossier du journal",
    openLogFolderFailed: "Impossible d’ouvrir le dossier du journal",
    counter: (shown, total) =>
      `${formatFr(shown)} sur ${formatFr(total)} ${total <= 1 ? "entrée" : "entrées"}`,
    footerNote:
      "Le journal peut contenir des noms de fichiers et d’albums. Vérifiez-le avant de le partager.",
    listLabel: "Entrées du journal d’activité",
    emptyTitle: "Rien n’a encore été journalisé",
    emptyBody: "L’activité apparaît ici au fil de votre utilisation de l’application.",
    noMatchTitle: "Aucune entrée ne correspond à ces filtres",
    noMatchBody: "Essayez d’activer d’autres niveaux ou d’élargir la période.",
    resetFilters: "Réinitialiser les filtres",
    jumpToLatest: "Aller aux plus récentes",
    newEntries: (count) => `${formatFr(count)} ${count <= 1 ? "nouvelle" : "nouvelles"}`,
    slowBadge: "LENT",
    slowBadgeTitle: (duration) => `Plus lent que prévu : ${duration}`,
    unexpectedEnd:
      "La session précédente ne s’est pas terminée normalement : l’application a peut-être planté ou été fermée de façon inattendue.",
    errors: {
      poll: (reason) => `Impossible de lire le journal d’activité : ${reason}`,
      history: (reason) => `Impossible de charger les sessions précédentes : ${reason}`,
      verbose: (reason) => `Impossible de modifier le mode détaillé : ${reason}`,
    },
    dialog: {
      title: "Effacer le journal d’activité ?",
      body: "Cette action supprime toutes les entrées, y compris les fichiers enregistrés sur cet ordinateur. Elle est irréversible.",
      confirm: "Effacer le journal",
      confirming: "Effacement…",
      cancel: "Annuler",
      failed: (reason) => `Impossible d’effacer le journal : ${reason}`,
    },
  },
};

export function useActivityLogLabels(): ActivityLogLabels {
  const { locale } = useI18n();
  return messages[locale];
}

export { messages as activityLogMessages };
