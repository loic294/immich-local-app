import type { ToastRequest } from "../toasts/toastRequest";

/**
 * Toasts for a finished favorite or unfavorite batch: a success for the photos that changed and an
 * error for those that failed. The store coalesces repeated pushes into one counted toast.
 */
export function favoriteResultToasts(
  favorite: boolean,
  requested: number,
  failed: number,
): ToastRequest[] {
  const succeeded = Math.max(0, requested - failed);
  const requests: ToastRequest[] = [];
  if (succeeded > 0) {
    requests.push({
      kind: "success",
      key: favorite ? "asset.favorited" : "asset.unfavorited",
      params: { count: succeeded },
    });
  }
  if (failed > 0) {
    requests.push({
      kind: "error",
      key: favorite ? "asset.favoriteFailed" : "asset.unfavoriteFailed",
      params: { count: failed },
    });
  }
  return requests;
}

/** Toast for a single-photo favorite toggle (exactly one request: success or failure). */
export function singleFavoriteToast(favorite: boolean, succeeded: boolean): ToastRequest {
  return favoriteResultToasts(favorite, 1, succeeded ? 0 : 1)[0];
}
