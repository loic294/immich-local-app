/**
 * True when a failed request means the server could not be reached. Tauri rejects
 * with plain strings, so both strings and Errors are inspected for the `offline:`
 * marker.
 */
export function isOfflineFailure(failure: unknown): boolean {
  const raw =
    failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  return raw.startsWith("offline:");
}

/** The offline notice for unreachable-server failures, otherwise the fallback text. */
export function failureMessage(failure: unknown, fallback: string, offline: string): string {
  return isOfflineFailure(failure) ? offline : fallback;
}
