import type { ToastRequest } from "./toastRequest";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** One toast per asset whose trash/archive/restore state changed; the store coalesces them. */
export function toastForDeletionChange(detail: unknown): ToastRequest | null {
  if (!isRecord(detail) || typeof detail.id !== "string") return null;
  if (detail.isTrashed === true) return { kind: "success", key: "asset.trashed" };
  if (detail.isArchived === true || detail.visibility === "archive") {
    return { kind: "success", key: "asset.archived" };
  }
  return { kind: "success", key: "asset.restored" };
}

export function toastForTimeShift(detail: unknown): ToastRequest | null {
  if (!isRecord(detail) || !Array.isArray(detail.assetIds) || detail.assetIds.length === 0) {
    return null;
  }
  return { kind: "success", key: "asset.timeShifted", params: { count: detail.assetIds.length } };
}
