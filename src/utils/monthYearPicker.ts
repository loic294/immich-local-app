export const MIN_PICKER_YEAR = 1900;
export const MAX_PICKER_YEAR = 2100;
export const YEARS_PER_PAGE = 12;

/** Keeps a year inside the range the quick picker can show. */
export function clampYear(year: number): number {
  return Math.min(MAX_PICKER_YEAR, Math.max(MIN_PICKER_YEAR, year));
}

/** First year of the fixed-size year page that contains `year`. */
export function yearPageStart(year: number): number {
  const offset = clampYear(year) - MIN_PICKER_YEAR;
  return MIN_PICKER_YEAR + Math.floor(offset / YEARS_PER_PAGE) * YEARS_PER_PAGE;
}

/** Years listed on the page that starts at `pageStart`, within the supported range. */
export function yearsOnPage(pageStart: number): number[] {
  const years: number[] = [];
  for (let year = pageStart; year < pageStart + YEARS_PER_PAGE; year += 1) {
    if (year >= MIN_PICKER_YEAR && year <= MAX_PICKER_YEAR) {
      years.push(year);
    }
  }
  return years;
}

/** Moves a year page start by `direction` pages without leaving the supported range. */
export function shiftYearPage(pageStart: number, direction: -1 | 1): number {
  return yearPageStart(pageStart + direction * YEARS_PER_PAGE);
}
