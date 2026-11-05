import { useI18n } from "./index";

const messages = {
  "en-CA": {
    chooseMonthYear: "Choose month and year",
    chooseYear: "Choose a year",
    previousYear: "Previous year",
    nextYear: "Next year",
    previousYears: "Previous years",
    nextYears: "Next years",
    backToCalendar: "Back to calendar",
  },
  "fr-CA": {
    chooseMonthYear: "Choisir le mois et l’année",
    chooseYear: "Choisir une année",
    previousYear: "Année précédente",
    nextYear: "Année suivante",
    previousYears: "Années précédentes",
    nextYears: "Années suivantes",
    backToCalendar: "Retour au calendrier",
  },
};

export type MonthYearPickerMessageKey = keyof (typeof messages)["en-CA"];

export function useMonthYearPickerI18n(): (key: MonthYearPickerMessageKey) => string {
  const { locale } = useI18n();
  return (key) => messages[locale][key];
}
