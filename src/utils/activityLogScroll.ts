/** How close to the end (in px) still counts as "at the bottom", so a sub-row nudge isn't a pause. */
export const BOTTOM_TOLERANCE_PX = 32;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isNearBottom(
  { scrollTop, scrollHeight, clientHeight }: ScrollMetrics,
  tolerance: number = BOTTOM_TOLERANCE_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= tolerance;
}

export interface ScrollObservation {
  atBottom: boolean;
  /** The scroll position went up since the previous scroll event. */
  movedUp: boolean;
}

/**
 * Whether the list should keep following the newest entry after a scroll event: reaching the
 * bottom resumes, scrolling up pauses, and anything else (a layout shift, scrolling down but not
 * yet there) keeps the current state so content growing under us never pauses by accident.
 */
export function nextFollowing(
  following: boolean,
  { atBottom, movedUp }: ScrollObservation,
): boolean {
  if (atBottom) return true;
  return movedUp ? false : following;
}
