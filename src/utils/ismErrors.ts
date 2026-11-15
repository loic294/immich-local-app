export type IsmErrorCode =
  | "maintenance_blocked"
  | "direct_writes_unavailable"
  | "revision_changed"
  | "destination_exists"
  | "root_unavailable"
  | "asset_identity"
  | "owner_transfer";

export type IsmErrorLabels = Record<IsmErrorCode, string>;

const CODES: [IsmErrorCode, RegExp][] = [
  ["maintenance_blocked", /\bmaintenance_blocked\b/],
  ["direct_writes_unavailable", /\bdirect_writes_unavailable\b/],
  ["revision_changed", /\brevision_changed\b/],
  ["destination_exists", /\bdestination_exists\b/],
  ["root_unavailable", /\broot_unavailable\b/],
  ["asset_identity", /\basset_identity_(required|changed|unverified)\b/],
  ["owner_transfer", /\bowner_transfer_(required|blocked)\b/],
];

/** Finds the ISM refusal code in a command error ("ISM <code>: …" or "ISM operation failed: <code>: …"). */
export function ismErrorCode(error: unknown): IsmErrorCode | null {
  const message = error instanceof Error ? error.message : String(error);
  return CODES.find(([, pattern]) => pattern.test(message))?.[0] ?? null;
}

/** Explains known ISM refusals in the user's language and keeps the server detail for the rest. */
export function ismErrorMessage(error: unknown, labels: IsmErrorLabels): string {
  const code = ismErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code ? labels[code] : message;
}
