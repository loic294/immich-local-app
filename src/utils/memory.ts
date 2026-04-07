import { AssetSummary, MemorySummary } from "../types";

export type MemoryItem = {
  id: string;
  coverAssetId: string;
  label: string;
  name: string;
  assets: AssetSummary[];
};

export function toMemoryItem(memory: MemorySummary): MemoryItem | null {
  const cover = memory.assets[0];
  if (!cover) {
    return null;
  }

  const label =
    memory.title?.trim() ||
    getYearsAgoLabel(memory.memoryAt, memory.year) ||
    "Memory";

  return {
    id: memory.id,
    coverAssetId: cover.id,
    label,
    name: cover.originalFileName,
    assets: memory.assets,
  };
}

export function getYearsAgoLabel(
  memoryAt: string | null,
  year: number | null,
): string | null {
  const nowYear = new Date().getFullYear();

  if (typeof year === "number" && Number.isFinite(year)) {
    const years = Math.max(1, nowYear - year);
    return `${years} year${years > 1 ? "s" : ""} ago`;
  }

  if (memoryAt) {
    const date = new Date(memoryAt);
    if (!Number.isNaN(date.getTime())) {
      const years = Math.max(1, nowYear - date.getFullYear());
      return `${years} year${years > 1 ? "s" : ""} ago`;
    }
  }

  return null;
}
