/** Tauri rejects with plain strings, so strings and Errors are both turned into readable text. */
export function describeActivityError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
